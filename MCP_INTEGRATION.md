# MCP 集成说明

本项目只使用麦当劳官方 MCP Server（`https://mcp.mcd.cn`）的**企业团餐**能力，不接入任何第三方数据源。

## 使用的 MCP Server

| 项 | 值 |
|---|---|
| Server 名称 | `mcd-mcp` |
| 传输方式 | `streamablehttp` |
| Endpoint | `https://mcp.mcd.cn` |
| 鉴权 | 请求头 `Authorization: Bearer ${MCP_TOKEN}` |

配置文件见 [`mcp-config.example.json`](./mcp-config.example.json)，Token 以环境变量占位符表示，仓库内不含任何真实凭证。

## 使用的 Tool

### 核心调用链（按顺序）

| # | Tool | 用途 | 关键入参 | 关键出参 |
|---|---|---|---|---|
| 1 | `delivery-query-addresses` | 获取用户已保存的配送地址 | 无 | `addressId`、`contactName`、`fullAddress`、`phone` |
| 2 | `delivery-query-stores` | 查询该地址可配送的团餐门店 | `beType=6`、`addressId` | `storeCode`、`beCode`、`storeName`、`address`、`reservation`、`reservationTimeOptions` |
| 3 | `query-meal-assistance` | 获取门店可用助餐服务 | `storeCode`、`beCode`、`orderType=2`、`beType=6`、`reservationDate?` | `gmServiceCode` |
| 4 | `query-promotions` | 获取门店当前有效的满减/满折规则 | 同上 | `promotionId`、`promotionType`、`ruleCategory`、`threshold`、`products`、`ruleDetail` |
| 5 | `query-meals` | 获取门店在售餐品 | 同上 | `productCode`、`name`、`price`（单位：分） |
| 6 | `calculate-price` | 计算实际价格并校验估算 | 上述 + `items`、`gmServiceCode`、`needTableware` | 各金额字段（**单位：分**） |
| 7 | `auto-bind-coupons` | 试算叠加优惠券后的价格 | `items` | 可用券与抵扣后金额 |
| 8 | `query-my-coupons` | 读取用户卡包优惠券资产 | 无 | 券列表、有效期、核销状态 |
| 9 | `query-my-account` | 读取积分账户 | 无 | `availablePoint`、`expiredPoint`、`currentMouthExpirePoint` |
| 10 | `create-order` | 用户确认后创建团餐订单 | 上述全部 + 配送信息 | `orderId`、订单金额 |

### 辅助 Tool

| Tool | 用途 |
|---|---|
| `now-time-info` | 校验当前时间，辅助判断是否需要预约配送 |
| `list-nutrition-foods` | 在需要说明热量/钠含量时提供参考数据 |
| `query-order` / `order-list` | 核对历史团餐订单，用于复盘成本 |

## 关键业务约束

### 一、仅使用企业团餐场景（beType=6）

`query-meal-assistance` 和 `query-promotions` 两个接口**仅在企业团餐场景下可用**，必须满足：

| 参数 | 取值 |
|---|---|
| `beType` | 固定 `6` |
| `orderType` | 固定 `2` |
| `beCode` | 必传，来自 `delivery-query-stores`（beType=6）返回值 |

这是本项目的**能力边界**：它只服务于团体客户，不覆盖个人零售点单。

**实测验证**：对同一门店（storeCode=1420930，beCode=142093041）分别以 `beType=6` 与
不传 `beType` 调用 `query-meal-assistance`，返回结果如下：

| 调用方式 | 返回 |
|---|---|
| 传 `beType=6` | `success: true`，正常返回助餐服务列表 |
| 不传 `beType` | `success: false`，`code: 610501`，**「仅支持企业团餐场景下使用助餐服务」** |

这说明服务端存在**真实的场景校验**，而非仅靠文档约定。
任何以个人身份调用这两个接口的方案都无法获取团餐数据 —— 这正是本项目成立的依据。

### 二、`beCode` 与 `storeCode` 必须来自上游返回值

这两个参数无法由用户臆测，必须严格从 `delivery-query-stores` 的返回结果中获取并原样传递。任何自行构造都会导致接口报错。

### 三、价格单位为「分」

`calculate-price` 与 `query-meals` 返回的价格字段**单位均为分**，必须除以 100 后展示。项目内部计算全程使用「分」，仅在渲染给用户时转换为「元」，以避免企业场景下的对账误差。

### 四、促销规则的真实结构（2026-10-18 实测校验）

以下是调用 `query-promotions`（storeCode=1420930，beCode=142093041，beType=6）实际返回的结构，
本项目的解析逻辑已按此实现，**并非根据文档推测**：

```json
{
  "promotionId": "331878002",
  "promotionType": "33",
  "ruleCategory": 30,
  "beTypes": ["6"],
  "startTime": "2025-03-01 00:00:00",
  "endTime": "2026-12-31 23:59:59",
  "gmServiceCode": "GMS001",
  "products": [{ "type": "2", productCode": "9900016058" }],
  "ruleDetail": {
    "orderDiscount": { "discount": "30", "startDiscountPoint": "1000" }
  }
}
```

**四个必须知道的陷阱：**

1. **`discount` 是「减免百分比」，不是「折后比例」。**
   `discount: "30"` 表示减免 30%，即实付 70% = **7 折**。
   误当作「3 折」理解会让优惠金额算错一个数量级。

2. **门槛与减免金额的单位是「元」，不是「分」。**
   `startDiscountPoint: "1000"` 表示 1000 元。
   而 `calculate-price` 返回的价格是「分」。**同一次流程里存在两种单位**，必须逐字段区分。

3. **每条规则绑定一个助餐服务（`gmServiceCode`）。**
   实测同一门店中，GMS001（保鲜速达）满 1000 打 7 折，而 GMS003（专人摆台）满 1000 仅打 8.5 折。
   若不按助餐服务过滤规则，会把高门槛服务的优惠算进低门槛服务的方案，**优惠金额虚高**。
   本项目通过 `filterPromosByService()` 处理。

4. **规则门槛跨度远大于预期。**
   实测该店团餐门槛从 300 元到 2000 元不等，且**几乎全部是满折（promotionType=33）而非满减（31）**。
   规则结构 `ruleDetail` 有两个互斥分支：
   - `orderDiscount`：满折，含 `discount` 与 `startDiscountPoint`
   - `orderReduce`：满减，含 `reduceInfo` 阶梯数组，每档有 `startDiscountPoint` 与 `reduceAmount`

### 五、助餐服务的可用性受时间限制

`query-meal-assistance` 返回的 `unusableReason` 字段说明原因。实测返回：

| gmServiceCode | 名称 | 服务内容 | 实测状态 |
|---|---|---|---|
| GMS001 | 保鲜速达 | 准时送达 & 餐品保温 | 可用（默认选中） |
| GMS002 | 专人分餐 | 准时送达、送餐到桌/到人 | 不可用 |
| GMS003 | 专人摆台 | 准时送达、餐品摆台、专人服务 | 不可用 |

不可用原因原文为「专人服务仅对送达时间为 07:00~20:00 点的订单可享」。
**深夜下单时只能选 GMS001**，而 GMS001 恰好也是折扣最优的一档 —— 但这是巧合，
Skill 必须根据实际 `unusableReason` 展示可选范围，不能硬编码推荐。

### 六、预约参数与营业时段约束

实测发现 `query-meals` 在非营业时段会直接失败：

```
{"success":false,"code":600057,"message":"门店可能已关闭或不在营业时间"}
```

麦当劳门店的营业时段被细分为早餐 / 午餐 / 下午茶 / 夜市 / 宵夜，
且**不同门店的时段划分不同**（实测有门店 07:00-24:00，有门店全天可送）。
因此：

- 预约场景**必须**传 `reservationDate`，且需落在 `reservationTimeOptions` 列出的时段内
- 非预约场景在深夜可能因超出营业时段而无法取餐
- `reservationTimeOptions` 中的每一条都必须展示给用户，不得省略

## 调用流程图

```
用户需求（人数 / 预算 / 时间 / 地址）
        │
        ▼
delivery-query-addresses ──────► 选择地址，取 addressId
        │
        ▼
delivery-query-stores(beType=6) ────► 门店列表 + 预约时段，取 storeCode / beCode
        │
        ├──────────────┬──────────────────┐
        ▼              ▼                  ▼
query-meal-       query-promotions    query-meals
assistance        （满减/满折规则）     （在售餐品 + 价格）
        │              │                  │
        │              └────────┬─────────┘
        ▼                       ▼
    gmServiceCode        plan-catering.js
                         （配餐求解 + 凑单优化）
                                 │
                                 ▼
                     calculate-price（校验实付金额）
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
          auto-bind-coupons              create-order
          （试算叠加券后价格）         （仅用户确认后执行）
```

## 业务价值

| 痛点 | 本项目的处理方式 |
|---|---|
| 门店满减规则是原始结构化数据，人工解读易错 | 自动识别 `promotionType` / `ruleCategory` 并换算为自然语言规则 |
| 按菜单逐项手算总价耗时，20 人以上极易出错 | 求解器一次性完成档位匹配、轮转搭配与凑单计算 |
| 一味压低单价会导致配餐结构失衡 | 优先保住主餐，削减时显式告知，并给出预算调整建议 |
| 团餐餐品雷同，20 份同款汉堡观感与体验差 | 主餐轮换、小食按使用次数最少优先 |
| 报价与实际计费可能不一致 | 用 `calculate-price` 二次核对，差异如实告知 |

## 安全与合规

- 仓库内所有配置均使用 `${MCP_TOKEN}` 环境变量占位符，不含真实 Token
- `addressId`、`beCode`、`orderId` 等用户数据仅在运行时透传，不写入仓库、不落盘、不外传
- 项目不包含任何第三方外链、埋点或数据上报逻辑
- `create-order` 仅在用户明确确认后调用

## 免责声明

本项目为麦当劳程序员节创意开发大赛参赛作品，由参赛者独立开发，非麦当劳官方产品。输出结果仅供参考，不构成任何商业承诺；实际餐品、价格、优惠与配送范围以麦当劳官方渠道实时结果为准。