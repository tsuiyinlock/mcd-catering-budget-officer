/**
 * 团餐预算官 - 配餐预算求解器
 * ================================================================
 *
 * 把「N 人、预算 B、某门店、某时段」翻译成一份可下单的配餐清单，
 * 并在满减 / 满折规则下做凑单优化（snap to threshold）。
 *
 * 设计原则
 * --------
 * 1. 纯计算、无副作用：不联网、不下单，只算数。
 *    真实数据由 Agent 通过 MCP 工具取得后传入本模块。
 * 2. 所有金额单位统一为「分」，避免浮点误差，展示层再除以 100。
 * 3. 官方配餐比例规则来自 query-meals 工具描述，非本项目臆造。
 * 4. 小食按累计使用次数轮转，避免团餐里出现「三十份同款薯条」。
 * 5. 优惠规则默认「取最优单条」而非叠加 —— 企业对账时叠加口径易产生纠纷。
 *
 * @module plan-catering
 */

'use strict';

/** 官方配餐比例规则（来源：query-meals 工具描述的 beType=6 搭配规则） */
const TIER_RULES = [
  {
    minPerCapita: 0,
    maxPerCapita: 2000,
    label: '20 元以下',
    structure: { main: 0, side: 1, drink: 0 },
    note: '以小食为主，适合下午茶或加餐场景',
  },
  {
    minPerCapita: 2000,
    maxPerCapita: 3000,
    label: '20-30 元',
    structure: { main: 1, side: 1, drink: 0 },
    note: '汉堡 + 小食，或汉堡 + 饮料',
  },
  {
    minPerCapita: 3000,
    maxPerCapita: 4000,
    label: '30-40 元',
    structure: { main: 1, side: 1, drink: 1 },
    note: '汉堡 + 薯条/小食 + 饮料',
  },
  {
    minPerCapita: 4000,
    maxPerCapita: 5000,
    label: '40-50 元',
    structure: { main: 1, side: 1, drink: 1 },
    note: '汉堡 + 薯条 + 小食 + 饮料',
  },
  {
    minPerCapita: 5000,
    maxPerCapita: Infinity,
    label: '50 元以上',
    structure: { main: 1, side: 2, drink: 1 },
    note: '丰富组合，优先不重复小食',
  },
];

/** 类目别名归一化：不同门店返回的类目字段可能写法不一 */
const CATEGORY_ALIASES = {
  burger: 'main',
  hamburger: 'main',
  main: 'main',
  combo: 'main',
  主餐: 'main',
  汉堡: 'main',
  套餐: 'main',
  side: 'side',
  snack: 'side',
  fries: 'side',
  小食: 'side',
  薯条: 'side',
  配餐: 'side',
  甜品: 'side',
  drink: 'drink',
  beverage: 'drink',
  coffee: 'drink',
  饮料: 'drink',
  汤: 'drink',
  咖啡: 'drink',
};

/** promotionType 语义（来源：query-promotions 工具描述） */
const PROMO_FULL_REDUCTION = 31; // 满额减
const PROMO_ORDER_DISCOUNT = 33; // 订单折扣

function toFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

function toYuan(fen) {
  return (Math.round(Number(fen)) / 100).toFixed(2);
}

/**
 * 归一化餐品对象
 * @param {object} raw MCP query-meals 返回的原始餐品
 * @returns {{productCode:string,name:string,priceFen:number,categoryRaw:string,category:string}}
 */
function normalizeMenuItem(raw) {
  const priceFen = Number(raw.priceFen ?? raw.price ?? 0);
  const categoryRaw = String(raw.categoryRaw ?? raw.category ?? raw.type ?? '');
  const key = categoryRaw.trim().toLowerCase();
  return {
    productCode: String(raw.productCode ?? raw.code ?? ''),
    name: String(raw.name ?? raw.productName ?? '未命名餐品'),
    priceFen,
    categoryRaw,
    category: CATEGORY_ALIASES[key] || 'side',
  };
}

/**
 * 归一化促销规则
 * @param {object} raw MCP query-promotions 返回的原始规则
 * @returns {{promotionId:string,promotionType:number,thresholdFen:number,minusFen:number,discountBps:number,description:string,label:string}}
 */
/**
 * 归一化促销规则
 *
 * 字段说明依据 `query-promotions` 实际返回结构（2026-10 实测）：
 *   ruleDetail.orderDiscount = { discount, startDiscountPoint }
 *     discount            折扣值，语义为「减免百分比」：30 表示减免 30%，即实付 7 折
 *     startDiscountPoint  触发门槛，单位「元」
 *   ruleDetail.orderReduce = { reduceInfo: [{ startDiscountPoint, reduceAmount }] }
 *     startDiscountPoint  门槛，单位「元」
 *     reduceAmount        减免金额，单位「元」
 *   gmServiceCode         该规则绑定的助餐服务，不同助餐服务适用不同规则
 *   products              适用餐品范围，type: 1-包含 2-不包含 3-全部
 *
 * ⚠️ 门店门槛与减免金额单位为「元」，本模块统一换算为「分」后再参与计算。
 *
 * @param {object} raw MCP query-promotions 返回的原始规则
 * @returns {object} 归一化后的促销规则
 */
function normalizePromotion(raw) {
  const promotionType = Number(raw.promotionType ?? PROMO_FULL_REDUCTION);
  const gmServiceCode = String(raw.gmServiceCode ?? '');
  const ruleDetail = raw.ruleDetail || {};
  const orderDiscount = ruleDetail.orderDiscount || null;
  const orderReduce = ruleDetail.orderReduce || null;

  // 满折规则
  let thresholdFen = 0;
  let discountPercent = 0;
  if (orderDiscount) {
    // 门槛单位是「元」，转「分」
    thresholdFen = Math.round(Number(orderDiscount.startDiscountPoint ?? 0) * 100);
    // discount=30 → 减免 30% → 存为 3000 万分比，便于统一运算
    discountPercent = Number(orderDiscount.discount ?? 0);
  }

  // 满减规则：门槛阶梯，此处取最低一档作为触发门槛，最高减免作为代表值
  let minusFen = 0;
  const reduceLadder = [];
  if (orderReduce && Array.isArray(orderReduce.reduceInfo)) {
    for (const step of orderReduce.reduceInfo) {
      reduceLadder.push({
        thresholdFen: Math.round(Number(step.startDiscountPoint ?? 0) * 100),
        minusFen: Math.round(Number(step.reduceAmount ?? 0) * 100),
      });
    }
    reduceLadder.sort((a, b) => a.thresholdFen - b.thresholdFen);
    if (reduceLadder.length > 0) {
      thresholdFen = reduceLadder[0].thresholdFen;
      minusFen = reduceLadder[0].minusFen;
    }
  }

  // 适用餐品范围
  const products = Array.isArray(raw.products) ? raw.products : [];
  const productScope = products.length === 0 ? 3 : Number(products[0].type ?? 3);

  const promo = {
    promotionId: String(raw.promotionId ?? ''),
    promotionType,
    ruleCategory: Number(raw.ruleCategory ?? 0),
    gmServiceCode,
    thresholdFen,
    minusFen,
    discountPercent,
    reduceLadder,
    productScope,
    excludedProductCodes:
      productScope === 2 ? products.map((p) => String(p.productCode)).filter(Boolean) : [],
    description: String(raw.description ?? ''),
  };
  promo.label = buildPromoLabel(promo);
  return promo;
}

function buildPromoLabel(p) {
  if (p.promotionType === PROMO_ORDER_DISCOUNT) {
    const payRatio = ((100 - p.discountPercent) / 10).toFixed(2);
    return `满 ${toYuan(p.thresholdFen)} 打 ${payRatio.replace(/\.?0+$/, '')} 折`;
  }
  if (p.promotionType === PROMO_FULL_REDUCTION) {
    if (p.reduceLadder.length > 1) {
      const parts = p.reduceLadder.map(
        (s) => `满 ${toYuan(s.thresholdFen)} 减 ${toYuan(s.minusFen)}`,
      );
      return parts.join('；');
    }
    return `满 ${toYuan(p.thresholdFen)} 减 ${toYuan(p.minusFen)}`;
  }
  return p.description || '未知规则';
}

/**
 * 计算单条规则能减免的金额（分）。不满足门槛返回 0。
 *
 * @param {object} promo 归一化后的规则
 * @param {number} amountFen 订单原价（分）
 * @returns {number} 减免金额（分）
 */
function discountFor(promo, amountFen) {
  if (amountFen < promo.thresholdFen) return 0;

  if (promo.promotionType === PROMO_ORDER_DISCOUNT) {
    // 满折：discount 为减免百分比，26 表示减免 26%
    const cut = Math.floor((amountFen * promo.discountPercent) / 100);
    return Math.min(cut, amountFen);
  }

  if (promo.promotionType === PROMO_FULL_REDUCTION) {
    // 满减：有阶梯时按实际命中的最高档计算
    if (promo.reduceLadder.length > 1) {
      let hit = null;
      for (const step of promo.reduceLadder) {
        if (amountFen >= step.thresholdFen) hit = step;
      }
      return hit ? Math.min(hit.minusFen, amountFen) : 0;
    }
    return Math.min(promo.minusFen, amountFen);
  }

  return 0;
}

/** 在候选规则中筛选出实际可命中、且减免最大的那一条 */
function bestDiscount(amountFen, promos) {
  return promos.reduce((max, p) => Math.max(max, discountFor(p, amountFen)), 0);
}

function appliedPromos(amountFen, promos) {
  const hits = promos.filter((p) => discountFor(p, amountFen) > 0);
  if (hits.length === 0) return [];
  const best = hits.reduce((a, b) => (discountFor(b, amountFen) > discountFor(a, amountFen) ? b : a));
  return [best];
}

/**
 * 按助餐服务过滤规则。
 *
 * 实测发现：每条促销规则都绑定一个 gmServiceCode，不同助餐服务适用不同门槛与折扣。
 * 若不按服务过滤，会把「专人分餐不可用时」的规则也算进方案，导致优惠金额虚高。
 *
 * @param {Array<object>} promos 全部规则
 * @param {string} gmServiceCode 实际选用的助餐服务编码
 * @returns {Array<object>} 该服务适用的规则
 */
function filterPromosByService(promos, gmServiceCode) {
  if (!gmServiceCode) return promos;
  const scoped = promos.filter((p) => !p.gmServiceCode || p.gmServiceCode === gmServiceCode);
  // 若该服务没有任何专属规则，回退到全部门槛规则
  const dedicated = scoped.filter((p) => p.gmServiceCode === gmServiceCode);
  return dedicated.length > 0 ? dedicated : scoped;
}

function pickTier(perCapitaFen) {
  return TIER_RULES.find((t) => perCapitaFen >= t.minPerCapita && perCapitaFen < t.maxPerCapita) || TIER_RULES[TIER_RULES.length - 1];
}

function groupMenu(menu) {
  const groups = { main: [], side: [], drink: [] };
  for (const item of menu) {
    if (!groups[item.category]) groups[item.category] = [];
    groups[item.category].push(item);
  }
  groups.main.sort((a, b) => b.priceFen - a.priceFen); // 主餐取贵的，提升档次
  groups.side.sort((a, b) => a.priceFen - b.priceFen); // 小食取便宜的，省预算
  groups.drink.sort((a, b) => a.priceFen - b.priceFen);
  return groups;
}

/** 小食轮转器：按累计使用次数最少者轮换，避免团餐全选同款 */
class SideRotator {
  constructor(options) {
    this.options = [...options];
    this.usage = new Map(this.options.map((o) => [o.productCode, 0]));
  }

  pick() {
    if (this.options.length === 0) return null;
    const chosen = this.options.reduce((best, cur) => {
      const ub = this.usage.get(best.productCode);
      const uc = this.usage.get(cur.productCode);
      if (uc < ub) return cur;
      if (uc === ub && cur.priceFen < best.priceFen) return cur;
      return best;
    });
    this.usage.set(chosen.productCode, this.usage.get(chosen.productCode) + 1);
    return chosen;
  }
}

function accumulate(items, menuItem) {
  const found = items.find((i) => i.productCode === menuItem.productCode);
  if (found) {
    found.quantity += 1;
    return;
  }
  items.push({
    productCode: menuItem.productCode,
    name: menuItem.name,
    quantity: 1,
    unitPriceFen: menuItem.priceFen,
    subtotalFen: menuItem.priceFen,
  });
}

function recalcSubtotal(items) {
  let sum = 0;
  for (const it of items) {
    it.subtotalFen = it.unitPriceFen * it.quantity;
    sum += it.subtotalFen;
  }
  return sum;
}

/** 按结构生成一份基础配餐清单 */
function buildBasket(headcount, structure, groups, slotOffset = 0, priceMode = 'premium') {
  const items = [];
  const sideCount = structure.side || 0;
  const drinkCount = structure.drink || 0;

  // 主餐数量严格遵守档位约束：structure.main 为 0 时不点任何主餐。
  // 档位结构来自官方 query-meals 搭配规则，不允许被「没菜单就凑合」破坏。
  const mainCount = structure.main || 0;
  let mains = [];
  if (mainCount > 0) {
    mains = groups.main.length > 0 ? [...groups.main] : [...groups.side];
    // premium：贵的优先（提升档次）；economy：便宜的优先（压预算）
    mains.sort((a, b) => (priceMode === 'economy' ? a.priceFen - b.priceFen : b.priceFen - a.priceFen));
  }

  // 主餐可轮换：20 人不必全点同一个汉堡（除非菜单只有一款）
  for (let i = 0; i < headcount * mainCount; i++) {
    if (mains.length === 0) break;
    accumulate(items, mains[(i + slotOffset) % mains.length]);
  }

  // 小食：使用次数最少优先
  const rotator = new SideRotator(groups.side);
  for (let i = 0; i < headcount * sideCount; i++) {
    const s = rotator.pick();
    if (!s) break;
    accumulate(items, s);
  }

  // 饮料：取次低价优先
  for (let i = 0; i < headcount * drinkCount; i++) {
    if (groups.drink.length === 0) break;
    accumulate(items, groups.drink[0]);
  }

  return items;
}

/**
 * 检测「再花一点、能省更多」的凑单机会。
 *
 * 必须排除当前已命中的那条规则 —— 否则会算出
 * 「已享受满1000打7折，再点100元还能触发满1000打7折」这种自相矛盾的提示。
 *
 * @param {number} subtotalFen 当前方案原价（分）
 * @param {Array<object>} promos 可用规则
 * @returns {string} 提示文案，无机会时返回空串
 */
function thresholdHint(subtotalFen, promos) {
  const sorted = [...promos].sort((a, b) => a.thresholdFen - b.thresholdFen);
  const currentCut = bestDiscount(subtotalFen, promos);

  for (const p of sorted) {
    if (p.thresholdFen <= subtotalFen) continue; // 已经够到门槛，不是「凑单」机会

    const need = p.thresholdFen - subtotalFen;
    // 在门槛处刚好凑满时的总减免 = 门槛上所有可用规则的最优叠加效果
    const gainAtThreshold = bestDiscount(p.thresholdFen, promos);
    const incremental = gainAtThreshold - currentCut;
    if (incremental > need) {
      return (
        `凑单提示：再点 ${toYuan(need)} 可触发「${p.label}」，净省 ${toYuan(incremental - need)}`
      );
    }
  }
  return '';
}

/**
 * 核心求解
 *
 * @param {{headcount:number, budgetTotalFen:number, menu:Array<object>,
 *          promotions?:Array<object>, gmServiceCode?:string, allowOverBudget?:boolean}} req
 * @param {number} req.headcount 用餐人数
 * @param {number} req.budgetTotalFen 总预算（分）
 * @param {Array<object>} req.menu 餐品列表，字段取自 query-meals 返回
 * @param {Array<object>} req.promotions 促销规则，字段取自 query-promotions 返回
 * @param {string} [req.gmServiceCode] 选用的助餐服务编码，用于过滤适用规则
 * @param {boolean} [req.allowOverBudget] 是否允许超出预算
 * @returns {object} PlanResult
 */
function planCatering(req) {
  const headcount = Number(req.headcount);
  const budgetTotalFen = Number(req.budgetTotalFen);
  const rawMenu = Array.isArray(req.menu) ? req.menu : [];
  const allPromos = (req.promotions || []).map(normalizePromotion);
  // 每条规则绑定具体助餐服务，不按服务过滤会算出无法兑现的优惠
  const gmServiceCode = String(req.gmServiceCode ?? '');
  const promos = filterPromosByService(allPromos, gmServiceCode);
  const allowOverBudget = Boolean(req.allowOverBudget);

  if (!Number.isFinite(headcount) || headcount <= 0) {
    throw new Error('headcount 必须为大于 0 的数字');
  }
  if (!Number.isFinite(budgetTotalFen) || budgetTotalFen <= 0) {
    throw new Error('budgetTotalFen 必须为大于 0 的数字（单位：分）');
  }
  if (rawMenu.length === 0) {
    throw new Error('menu 不能为空，请先通过 query-meals 获取该门店在售餐品');
  }

  const menu = rawMenu.map(normalizeMenuItem).filter((m) => m.priceFen > 0);
  if (menu.length === 0) {
    throw new Error('menu 中没有有效价格的餐品');
  }

  const warnings = [];
  const groups = groupMenu(menu);
  const perCapitaBudget = Math.floor(budgetTotalFen / headcount);
  const tier = pickTier(perCapitaBudget);

  if (groups.main.length === 0) {
    warnings.push('菜单中未识别到主餐类餐品，已降级为纯小食组合');
  }
  if (groups.drink.length === 0) {
    warnings.push('菜单中未识别到饮料类餐品，饮料位已跳过');
  }

  // 结构变体：主方案 + 降本方案（换便宜主餐/去饮料）+ 降档方案
  const candidates = [];
  const pushCandidate = (struct, offset, priceMode) => {
    const items = buildBasket(headcount, struct, groups, offset, priceMode);
    const subtotalFen = recalcSubtotal(items);
    const discountFen = bestDiscount(subtotalFen, promos);
    const cand = {
      items,
      subtotalFen,
      discountFen,
      finalFen: subtotalFen - discountFen,
      promos: appliedPromos(subtotalFen, promos),
      struct,
      priceMode,
    };
    candidates.push(cand);
    return cand;
  };

  // 1) 档位主方案：贵的主餐提升档次
  pushCandidate(tier.structure, 0, 'premium');
  // 2) 同档位降本：同样结构，但主餐换成便宜的
  pushCandidate(tier.structure, 0, 'economy');
  // 3) 降本变体：饮料位换小食（若饮料更贵则此项无效，会被价格筛掉）
  if (tier.structure.drink > 0) {
    const v = { ...tier.structure, side: (tier.structure.side || 0) + 1, drink: 0 };
    pushCandidate(v, 0, 'economy');
  }
  // 4) 降档方案：人均不够时退到下一档结构
  const tierIdx = TIER_RULES.indexOf(tier);
  if (tierIdx > 0) {
    pushCandidate(TIER_RULES[tierIdx - 1].structure, 0, 'economy');
  }
  // 5) 保主餐瘦身方案：砍掉小食/饮料，保住「一顿正经饭」的基本盘
  if ((tier.structure.main || 0) > 0) {
    pushCandidate({ main: tier.structure.main, side: 0, drink: 0 }, 0, 'economy');
  }

  // 选择策略（优先级从高到低，逐级兜底）：
  // 1) 满档方案（结构与档位完全一致）且预算内 → 直接用，这才是正常路径
  // 2) 降本方案（主餐换便宜 / 去饮料）且预算内 → 次优选择
  // 3) 瘦身方案（砍小食保主餐）且预算内 → 妥协，需提示
  // 4) 仅纯小食可兜住 → 明确告知主餐配不上
  // 5) 全部超预算 → 取最便宜并警告
  //
  // 关键约束：预算充足时绝不允许「省下来」就不点主餐 —— 人均 45 元只配 18 元是浪费额度。
  const structureScore = (c) => {
    const s = c.struct;
    const required = (tier.structure.main || 0) + (tier.structure.side || 0) + (tier.structure.drink || 0);
    const filled = (s.main || 0) + (s.side || 0) + (s.drink || 0);
    // 结构与档位完全一致记满分，每少一项扣一分
    return required > 0 ? filled / required : 0;
  };
  const isFullTier = (c) =>
    (c.struct.main || 0) === (tier.structure.main || 0) &&
    (c.struct.side || 0) === (tier.structure.side || 0) &&
    (c.struct.drink || 0) === (tier.structure.drink || 0);

  const affordable = candidates.filter((c) => c.finalFen <= budgetTotalFen);
  let best;
  let degraded = false;
  let trimmed = false;

  const fullTier = affordable.filter(isFullTier);
  const withMain = affordable.filter((c) => (c.struct.main || 0) > 0);

  if (fullTier.length > 0) {
    // 满档方案里选最划算的那个
    best = fullTier.reduce((a, b) => (b.finalFen < a.finalFen ? b : a));
  } else if (withMain.length > 0) {
    // 满档买不起，退而求其次：先取结构最完整的，再比价格
    best = withMain.reduce((a, b) => {
      const sa = structureScore(a);
      const sb = structureScore(b);
      if (Math.abs(sb - sa) > 0.01) return sb > sa ? b : a;
      return b.finalFen < a.finalFen ? b : a;
    });
    trimmed = (structureScore(best) + 0.01) < structureScore({ struct: tier.structure });
  } else if (affordable.length > 0) {
    best = affordable.reduce((a, b) => (b.finalFen < a.finalFen ? b : a));
    degraded = true;
  } else {
    best = candidates.reduce((a, b) => (b.finalFen < a.finalFen ? b : a));
    degraded = true;
    if (!allowOverBudget) {
      warnings.push('当前菜单与促销规则下无法压进预算，已给出最低价方案');
    }
  }

  // 削减了配菜：说清楚换来了什么，而不是让用户以为这就是最优解
  if (trimmed) {
    warnings.push('已优先保住主餐，削减了小食与饮料以压进预算；如预算可放宽，建议恢复完整搭配。');
  }

  // 兜底方案牺牲了主餐：必须说清楚，不能让用户以为这就是一顿正经午餐
  if (degraded && (best.struct.main || 0) === 0) {
    const pool = groups.main.length > 0 ? groups.main : groups.side;
    const cheapestMain = [...pool].sort((a, b) => a.priceFen - b.priceFen)[0];
    if (cheapestMain) {
      const perHead = Math.floor(budgetTotalFen / headcount);
      const gap = cheapestMain.priceFen - perHead;
      const affordableHeads = Math.floor(budgetTotalFen / cheapestMain.priceFen);
      warnings.push(
        `预算内无法覆盖主餐：人均 ¥${toYuan(perHead)} 不足一份${cheapestMain.name}` +
          `（¥${toYuan(cheapestMain.priceFen)}）。若要保留主餐，建议人均提高约 ` +
          `¥${toYuan(Math.ceil(gap))}，或将人数减至 ${affordableHeads} 人。`,
      );
    }
  }

  // 门槛按订单「原价」判定（满 1000 元指的是原价），因此传 subtotal 而非 final
  const hint = thresholdHint(best.subtotalFen, promos);
  if (hint) warnings.push(hint);

  const finalFen = best.finalFen;
  const gapFen = finalFen - budgetTotalFen;

  const alternatives = candidates
    .filter((c) => c !== best)
    .sort((a, b) => a.finalFen - b.finalFen)
    .slice(0, 2)
    .map((c) => ({
      structure: c.struct,
      finalFen: c.finalFen,
      perCapitaFen: Math.floor(c.finalFen / headcount),
    }));

  return {
    headcount,
    budgetTotalFen,
    items: best.items,
    tierLabel: tier.label,
    tierNote: tier.note,
    subtotalFen: best.subtotalFen,
    discountFen: best.discountFen,
    finalFen,
    appliedPromos: best.promos,
    budgetGapFen: gapFen,
    perCapitaFen: Math.floor(finalFen / headcount),
    warnings,
    alternatives,
  };
}

/** 渲染成人可直接阅读的方案文本 */
function formatPlan(plan) {
  const lines = [];
  lines.push(`【${plan.headcount} 人团餐预算方案】`);
  lines.push(`人均预算档位：${plan.tierLabel}（${plan.tierNote}）`);
  lines.push('');
  lines.push('配餐清单：');
  for (const it of [...plan.items].sort((a, b) => b.subtotalFen - a.subtotalFen)) {
    lines.push(`  · ${it.name} × ${it.quantity}  小计 ¥${toYuan(it.subtotalFen)}`);
  }
  lines.push('');
  lines.push(`原价合计：¥${toYuan(plan.subtotalFen)}`);
  if (plan.appliedPromos.length > 0) {
    for (const p of plan.appliedPromos) lines.push(`  适用优惠：${p.label}`);
    lines.push(`优惠减免：-¥${toYuan(plan.discountFen)}`);
  }
  lines.push(`到手合计：¥${toYuan(plan.finalFen)}`);
  lines.push(
    `人均：¥${toYuan(plan.perCapitaFen)}（预算 ¥${toYuan(Math.floor(plan.budgetTotalFen / plan.headcount))}/人）`,
  );
  if (plan.budgetGapFen > 0) {
    lines.push(`⚠ 超预算 ¥${toYuan(plan.budgetGapFen)}`);
  } else if (plan.budgetGapFen < 0) {
    lines.push(`✓ 结余 ¥${toYuan(-plan.budgetGapFen)}`);
  }
  for (const w of plan.warnings) lines.push(`注意：${w}`);
  if (plan.alternatives.length > 0) {
    lines.push('');
    lines.push('备选方案：');
    for (const alt of plan.alternatives) {
      lines.push(
        `  · 人均 ¥${toYuan(alt.perCapitaFen)}，合计 ¥${toYuan(alt.finalFen)}`,
      );
    }
  }
  return lines.join('\n');
}

/** 转为 calculate-price 工具可直接消费的 items 数组 */
function toCalculatePriceItems(plan) {
  return plan.items.map((it) => ({
    productCode: it.productCode,
    quantity: it.quantity,
  }));
}

module.exports = {
  TIER_RULES,
  PROMO_FULL_REDUCTION,
  PROMO_ORDER_DISCOUNT,
  planCatering,
  formatPlan,
  toCalculatePriceItems,
  normalizeMenuItem,
  normalizePromotion,
  filterPromosByService,
  discountFor,
  toFen,
  toYuan,
};

// 直接执行时跑自测
if (require.main === module) {
  const demoMenu = [
    { productCode: 'B01', name: '巨无霸汉堡', priceFen: 2200, categoryRaw: '汉堡' },
    { productCode: 'B02', name: '麦辣鸡腿汉堡', priceFen: 1900, categoryRaw: '汉堡' },
    { productCode: 'B03', name: '麦香鱼汉堡', priceFen: 2000, categoryRaw: '汉堡' },
    { productCode: 'S01', name: '中薯条', priceFen: 800, categoryRaw: '小食' },
    { productCode: 'S02', name: '麦辣鸡翅(2只)', priceFen: 1200, categoryRaw: '小食' },
    { productCode: 'S03', name: '黄金鸡块(5块)', priceFen: 1100, categoryRaw: '小食' },
    { productCode: 'S04', name: '芙蓉鲜蔬汤', priceFen: 700, categoryRaw: '小食' },
    { productCode: 'D01', name: '中可乐', priceFen: 700, categoryRaw: '饮料' },
    { productCode: 'D02', name: '鲜煮咖啡', priceFen: 900, categoryRaw: '饮料' },
    { productCode: 'D03', name: '柠檬红茶', priceFen: 750, categoryRaw: '饮料' },
  ];

  // 促销规则样例：结构取自 query-promotions 实际返回（2026-10-18 实测）
  // 注意门槛与减免单位为「元」，discount 为「减免百分比」，每条绑定 gmServiceCode
  const demoPromos = [
    {
      promotionId: '331868002',
      promotionType: '33',
      ruleCategory: 30,
      gmServiceCode: 'GMS001',
      products: [{ type: '2', productCode: '9900016058' }],
      ruleDetail: { orderDiscount: { discount: '22', startDiscountPoint: '300' } },
    },
    {
      promotionId: '331878002',
      promotionType: '33',
      ruleCategory: 30,
      gmServiceCode: 'GMS001',
      products: [{ type: '2', productCode: '9900016058' }],
      ruleDetail: { orderDiscount: { discount: '30', startDiscountPoint: '1000' } },
    },
    {
      promotionId: '331878001',
      promotionType: '33',
      ruleCategory: 30,
      gmServiceCode: 'GMS001',
      products: [{ type: '2', productCode: '9900016058' }],
      ruleDetail: { orderDiscount: { discount: '26', startDiscountPoint: '500' } },
    },
    {
      promotionId: '331878008',
      promotionType: '33',
      ruleCategory: 30,
      gmServiceCode: 'GMS003',
      products: [{ type: '2', productCode: '9900016058' }],
      ruleDetail: { orderDiscount: { discount: '7', startDiscountPoint: '300' } },
    },
  ];

  const cases = [
    { title: '场景一：20 人，人均 30 元（助餐服务 GMS001 保鲜速达）', headcount: 20, budgetYuan: 600, service: 'GMS001' },
    { title: '场景二：12 人，人均 22 元（预算偏紧）', headcount: 12, budgetYuan: 264, service: 'GMS001' },
    { title: '场景三：35 人，人均 45 元（大团餐，命中满 1000 档）', headcount: 35, budgetYuan: 1575, service: 'GMS001' },
    { title: '场景四：8 人，人均 18 元（下午茶档）', headcount: 8, budgetYuan: 144, service: 'GMS001' },
    { title: '场景五：35 人，改用 GMS003 专人摆台（折扣档位不同）', headcount: 35, budgetYuan: 1575, service: 'GMS003' },
  ];

  for (const c of cases) {
    console.log('='.repeat(62));
    console.log(c.title);
    console.log('='.repeat(62));
    const plan = planCatering({
      headcount: c.headcount,
      budgetTotalFen: toFen(c.budgetYuan),
      menu: demoMenu,
      promotions: demoPromos,
      gmServiceCode: c.service,
    });
    console.log(formatPlan(plan));
    console.log();
  }
  console.log(`自测完成：${cases.length} 个场景全部求解通过。`);
}