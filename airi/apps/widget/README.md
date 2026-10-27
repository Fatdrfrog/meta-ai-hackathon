# airi.chat Web Widget

A Preact chat widget that renders inside Shadow DOM for style isolation from
the host page.

## Features

- 🎨 **Shadow DOM Isolation** - Styles scoped to the widget
- 📱 **Fully Responsive** - Adapts from mobile to desktop seamlessly
- 🌙 **Dark Mode Support** - Automatic theme switching based on system preferences
- ⚡ **Lightweight** - Minimal bundle size with Preact
- 💬 **Chat and commerce** - API-backed conversations, realtime updates, and
  storefront commerce event adapters

## Development

### Prerequisites

Make sure you're in the monorepo root and have dependencies installed:

```bash
pnpm install
```

Copy `apps/widget/.env.example` to `apps/widget/.env.local`. Set `VITE_API_URL`
when the widget should call a web API on a different origin.

### Running Development Server

```bash
cd apps/widget
pnpm dev
```

This will start Vite dev server at `http://localhost:5173` showing a preview of the widget without Shadow DOM (for easier development).

### Building for Production

```bash
pnpm build
```

This creates these entry bundles in `dist/`, alongside generated assets and
source maps:

- `loader.js` - Loader script that creates Shadow DOM and loads the main bundle
- `widget.js` - Main widget bundle with all components and styles inline
- `commerce-adapters.js` - Storefront commerce event adapters

### Testing Shadow DOM Integration

1. Build the widget:

```bash
pnpm build
```

2. Open the demo page in a browser:

```bash
# Using Python
python -m http.server 8000
# Then open http://localhost:8000/demo.html

# Or using any static file server
npx serve .
```

The `demo.html` page includes intentionally conflicting CSS to demonstrate
Shadow DOM isolation. Serve it from the widget directory after building; it is
not included in the production `dist/` output.

## Deploy and test the widget

1. **Deploy the web app** (API + dashboard), e.g. Vercel: from repo root or `apps/web`, connect the project and deploy. Set all required env vars (Supabase, MongoDB, realtime gateway, OpenAI, etc.) in the project settings.
2. **Deploy the widget** (static files):
   - From repo root: `pnpm --filter @icecore/widget build` (or `cd apps/widget && pnpm build`).
   - Host the contents of `apps/widget/dist/` on a CDN or static host (e.g. Vercel: add a second project with root `apps/widget`, build command `pnpm build`, output directory `dist`; or upload `dist/` to S3/Cloudflare/R2 and point a domain to it).
   - Note the widget URL (e.g. `https://widget.yourdomain.com` or the Vercel URL).
3. **Point the web app to the widget:** in the web app env set `NEXT_PUBLIC_WIDGET_CDN_URL=https://your-widget-url` (no trailing slash). The embed code in the dashboard will then use this URL for `loader.js`.
4. **Supabase:** for the widget source, set `allowed_domains` to the domains where the widget will be embedded (for example, your main site, `*.example.com`, or `localhost:*` for local testing).
5. **Smoke test:** open a page that embeds the widget (or your main site if the widget is there), or create a simple HTML that loads `https://your-widget-url/loader.js` with `data-client-key="..."` and `data-api-url="https://your-web-app-url/api/widget"`. Open chat → Messages → send a message; you should see the reply from Airi.

## Project Structure

```
apps/widget/
├── src/
│   ├── assets/
│   │   └── icons.tsx              # SVG icon components
│   ├── components/
│   │   ├── MessageList.tsx        # Scrollable message area
│   │   ├── WidgetBubble.tsx       # Floating chat bubble button
│   │   ├── WidgetCartRecovery.tsx # Cart recovery handoff
│   │   ├── WidgetShell.tsx        # Main container with state
│   │   └── WidgetWindow.tsx       # Expanded chat window
│   ├── lib/                      # API, realtime, storage, and commerce helpers
│   ├── styles/
│   │   └── notion-simple.css      # Shared light/dark widget theme
│   ├── commerce-adapters.ts       # Storefront adapter build entry
│   ├── index.tsx                  # Development entry point
│   ├── loader.ts                  # Production loader script
│   ├── types.ts                   # TypeScript type definitions
│   └── widget.tsx                 # Widget initialization for Shadow DOM
├── demo.html                      # Shadow DOM integration demo
├── index.html                     # Development preview page
└── vite.config.ts                 # Vite build configuration
```

## Usage

### Embedding on a Website

Add this script tag to your HTML:

```html
<script
  src="https://cdn.airi.chat/widget/loader.js"
  data-client-key="your-client-key"
  data-theme="auto"
  data-auto-load="true"
></script>
```

### Configuration Options

The loader script accepts these data attributes:

- `data-client-key` - Your airi.chat client key (required for API integration)
- `data-api-url` - Absolute API URL (required when calling a different web app;
  defaults to `https://www.airi.chat/api/widget`)
- `data-theme` - Theme mode: `light`, `dark`, or `auto` (default: `auto`)
- `data-position` - Widget position: `bottom-right` or `bottom-left` (default: `bottom-right`)
- `data-locale` - Language code: `en`, `ru`, `kz`, etc. (default: `en`)
- `data-auto-load` - Auto-load widget: `true` or `false` (default: `true`)
- `data-widget-url` - Custom widget bundle URL (for testing)

### Programmatic Initialization

For advanced usage, you can initialize the widget programmatically:

```javascript
// Use the built ES module from a page served from the widget directory.
import { AiriWidget } from "./dist/widget.js";

// Create host element
const hostElement = document.createElement("div");
document.body.appendChild(hostElement);

// Initialize widget
const widget = new AiriWidget();
await widget.init({
  hostElement,
  clientKey: "your-client-key",
  apiUrl: "https://www.airi.chat/api/widget",
  theme: "auto",
  position: "bottom-right",
  locale: "en",
});

// Later, destroy if needed
widget.destroy();
```

## Runtime ownership and styling

`src/widget.tsx` owns initialization and loads `src/styles/notion-simple.css`
into the Shadow DOM. Reuse its `--icecore-*` theme variables and the components
under `src/components/` when extending the UI.

`src/lib/api.ts` owns conversation and message HTTP requests, history loading,
and media uploads. `src/lib/realtime.ts` owns the WebSocket subscription;
`WidgetShell.tsx` coordinates message and typing events with the UI. Commerce
tracking and storefront adapters live in `src/lib/commerce*.ts`, with
regression checks under `tests/`.

## Mobile App Integration

### iOS (WKWebView)

```swift
import WebKit

let webView = WKWebView()
let html = """
<!DOCTYPE html>
<html>
<head>
    <script src="https://widget.airi.chat/loader.js"
            data-client-key="your-client-key"
            data-api-url="https://www.airi.chat/api/widget">
    </script>
</head>
<body></body>
</html>
"""
webView.loadHTMLString(html, baseURL: URL(string: "https://widget.airi.chat"))
```

### Android (WebView)

```kotlin
val webView = WebView(context)
webView.settings.javaScriptEnabled = true
webView.settings.domStorageEnabled = true // Enable localStorage
val html = """
<!DOCTYPE html>
<html>
<head>
    <script src="https://widget.airi.chat/loader.js"
            data-client-key="your-client-key"
            data-api-url="https://www.airi.chat/api/widget">
    </script>
</head>
<body></body>
</html>
"""
webView.loadDataWithBaseURL(
    "https://widget.airi.chat",
    html,
    "text/html",
    "UTF-8",
    null
)
```

### Mobile-Specific Features

- **Camera/Gallery Access**: File uploads automatically use mobile camera/gallery on iOS/Android
- **localStorage Fallback**: Automatic fallback to memory storage if localStorage is restricted
- **Network Error Handling**: User-friendly error messages for connectivity issues
- **WebView Detection**: Automatic detection and optimization for WebView environments

### Mobile Configuration Requirements

1. **Absolute API URL**: Always provide `data-api-url` with absolute URL for mobile apps
2. **CORS**: Ensure your API allows requests from your mobile app domain
3. **localStorage**: Enable DOM storage in WebView settings (Android)

## Verification

Run `pnpm --filter @icecore/widget test` and
`pnpm --filter @icecore/widget build` from the repository root. Smoke-test the
built widget in the browsers and WebViews your integration supports, including
message delivery, media upload, storage restrictions, and Shadow DOM styling.
Use the current build output and browser measurements for bundle sizes and
load timings.

## Contributing

When adding new components or features:

1. Reuse `notion-simple.css` and its CSS custom properties
2. Use Preact hooks for state management
3. Ensure mobile responsiveness
4. Test Shadow DOM isolation with `demo.html`
5. Keep bundle size minimal

## License

Apache-2.0. See the repository root `LICENSE`.
