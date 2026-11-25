// Which files the viewer takes (R1): by extension, in any case. `.tif` and
// `.tiff` are included and work where the tool decodes them; SVG stays text.

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;

export function isImage(path: string): boolean {
  return path !== "" && IMAGE.test(path);
}

/** The last path component. */
export function baseName(path: string): string {
  const t = path.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}
