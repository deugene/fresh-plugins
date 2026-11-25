# fresh-plugins

Plugins for the [Fresh](https://github.com/sinelaw/fresh) editor. Each directory is one package.

| Plugin | Description | Install from URL |
|---|---|---|
| [git-sidebar](git-sidebar/) | Git section in the file-explorer sidebar: the branch, Staged Changes and Changes, kept current, in every Orchestrator window; stage, unstage, commit, side-by-side diff that opens the file at its line | `https://github.com/deugene/fresh-plugins#git-sidebar` |
| [image-viewer](image-viewer/) | An image file opens as the picture in its own tab, drawn in coloured half-block cells: PNG, JPEG, GIF, BMP and WebP, zoom from fit to 800%, keyboard panning, and its bytes on `b`. Uses ffmpeg, ImageMagick or macOS sips | `https://github.com/deugene/fresh-plugins#image-viewer` |

## Install

### From Fresh's package browser

This repository is also a package registry. Add it to Fresh once:

1. Open **Settings → Packages → Sources**, choose **[+] Add new** and enter exactly:

   ```
   https://github.com/deugene/fresh-plugins
   ```

   Leave the official registry in the list. Fresh names its copy of a registry after the exact URL, so don't add `.git` or a trailing slash.

2. Run **Package: Packages**, select a plugin, press `Enter` and choose **Install**.
3. Restart Fresh.

<details>
<summary>The same setting in <code>config.json</code></summary>

```json
{
  "packages": {
    "sources": [
      "https://github.com/sinelaw/fresh-plugins-registry",
      "https://github.com/deugene/fresh-plugins"
    ]
  }
}
```

This list replaces Fresh's default, so it has to name the official registry too.
</details>

New versions show with `↑` in **Package: Packages**. Select an installed plugin and choose **Update** to install the latest version.

If the browser lists nothing from this repository:

- Run it from a window that isn't attached to a dev container. Fresh syncs registries with git in the active window's environment, and from a container it can't write its copy.
- If the list is stale, delete `~/.config/fresh/plugins/packages/.index/` and open **Package: Packages** again.

### From a URL

Run **Package: Install from URL** with the plugin's URL from the table. From a local checkout, use `/path/to/fresh-plugins#<plugin>`. Then restart Fresh.

## License

MIT, see [LICENSE](LICENSE).
