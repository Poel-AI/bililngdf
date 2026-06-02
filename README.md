# Diet Fantasy Billing (server-side automation)

Desktop / local server UI for Unite Us billing. **Advanced options** (browser slots, show browser, `.env`, source folder) stay hidden until you **triple-click the green “Connected”** status in the header; triple-click again to hide.

The **Show browser** toggle and **Save settings** write `CONCURRENT_BROWSERS` and `HEADLESS` to the same `.env` as Electron (`DOTENV_PATH`). **Open source files** opens that folder in Finder/Explorer. “Show browser: On” sets `HEADLESS=false`.
