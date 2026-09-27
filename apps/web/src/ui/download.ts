/**
 * 程序化下载（U-017）：在 await 之后 window.open 会因丢失用户手势被浏览器弹窗拦截，
 * 表现为「点了没反应」。改用隐藏 <a> 点击触发下载（不走弹窗通道）。
 * 服务端响应带 Content-Disposition: attachment（L1 口径），无需 download 属性。
 */
export function downloadFile(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noreferrer noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
