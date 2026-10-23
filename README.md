# 金价监听站 · Cloudflare Worker

Cloudflare Worker 版的金价监控网站：定时抓取国际现货金价（XAU/USD），存到 KV，打开页面看实时价格、人民币/克换算、历史走势图，还能设价格预警。

## 功能

- 每 30 分钟自动抓取金价（gold-api.com 为主、goldprice.dev 兜底）
- 仪表盘：当前价、24h 涨跌、人民币/克换算、24h / 7d / 30d / 全部走势图
- 浏览器端价格预警（localStorage，打开页面自动检查）
- Telegram 机器人推送：价格穿越报警线时发消息（需配置，见下）

## 部署（纯网页操作）

1. 登录 dash.cloudflare.com → **Workers 和 Pages** → **创建** → **创建 Worker**，起个名（如 gold-monitor），点部署
2. 进这个 Worker → **设置** → **绑定** → **添加绑定** → **KV 命名空间** → 新建一个叫 `gold-prices` 的命名空间，变量名填 `GOLD_KV`，保存
3. **设置** → **触发器** → 添加 Cron 触发器，表达式填 `*/30 * * * *`
4. 右上角**编辑代码**，把 `worker.js` 的内容粘进去，**保存并部署**
5. 打开 Worker 的 `*.workers.dev` 域名。KV 初始为空，等第一次定时抓取（最多 30 分钟）后才有数据和图表

## Telegram 推送（可选）

1. Telegram 找 **@BotFather** → `/newbot` 建机器人，拿到 token
2. 找 **@userinfobot** 发任意消息，拿到你的 chat id（纯数字）
3. Worker → **设置** → **变量** → 添加变量：
   - `TG_BOT_TOKEN`（点**加密**）= 机器人 token
   - `TG_CHAT_ID`（点**加密**）= 你的 chat id
   - `ALERT_HIGH` = 涨破报警线，如 `4100`（可选）
   - `ALERT_LOW` = 跌破报警线，如 `3950`（可选）
4. 重新**编辑代码**粘贴部署（代码无改也行，变量即时生效）

价格穿越报警线时发一条 Telegram，回到区间内自动复位，不会重复打扰。

## 文件

- `worker.js` — 全部代码（定时抓取 + API + 前端页面，单文件）
