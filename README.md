# DevGlobe+

### Features

- Disabled links to repositories you can't access (private repositories or repositories you don't have permission to view);
- Added tooltips to indicate which country and language each flag represents.

### Installation
1. Open the browser extensions page.
2. Enable developer mode.
3. Load this folder as an unpacked extension.

### Target pages
- https://devglobe.app/space
- https://devglobe.xyz/space
- https://devglobe.app/developers/*
- https://devglobe.xyz/developers/*

### Notes
- No external API is used.
- Repository checks are performed with native `fetch` calls from the service worker.
- Repository link state is cache-first, then refreshed in the background when needed.
- the extension popup is available from the toolbar icon.

## Credits

[DevGlobe](https://devglobe.app) is developed and maintained by [CaadriFR](https://github.com/CaadriFR) and [Nakooo](https://github.com/Nako0).  
Icons are made by [TagSteel](https://github.com/TagSteel).
