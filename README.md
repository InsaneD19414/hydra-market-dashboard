# HYDRA Market Dashboard

A home-screen web app (PWA) for live crypto market monitoring, built for iPhone (Safari → Share → Add to Home Screen).

- **Live data:** Coinbase Exchange **public** market data only: the `ws-feed.exchange.coinbase.com` ticker websocket, with REST polling (`api.exchange.coinbase.com`) as the fallback. No account, no API keys.
- **Watchlist:** price, 24h and 1h change, 24h sparkline, 1h/5m/1d candle chart, and SPIKE/DIP badges.
- **Position panel:** live P&L against fee-inclusive break-even, plus distance to the take-profit and stop. You type the values in; nothing is read from any account.
- **Bot settings:** per-coin buy-trigger rules (dip %, RSI, lower band, breakout) with take-profit %, stop %, max $, cooldown and on/off. A fee-aware edge check is built in. Rules export and import as JSON in the `scanner_rules.json` schema.
- **Top gainers / losers:** live ranking of liquid USD pairs (public /products + /products/stats), volume floor adjustable, live websocket prices.
- **Buy / Sell:** order sheet with fee estimate, Open in Coinbase deep link, and Confirm & send (copies an APPROVED BY DARYELL request for Grok Bot). Confirm & send is your approval for that exact order.
- **Alerts:** in-app alerts, plus system notifications if you allow them. They work only while the app is open on screen.

**Alerts + order previews only. Every trade requires your approval in chat.** This app holds no credentials and cannot place, edit or cancel orders.

Palette: HYDRA red / black / gold / gray.
