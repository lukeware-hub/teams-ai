/** A markdown text as a link target that downloads it in the browser. */
export const mdDownload = (text: string) => `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
