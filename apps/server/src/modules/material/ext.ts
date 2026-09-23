/** 扩展名归一（实机验收修复：现代 Word 均为 .docx，原白名单仅 'doc' 直接拒收） */
export function normalizeUploadExt(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  const ext = i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
  // UPLOAD_FORMATS 白名单口径=文档族：docx→doc、markdown→md、xls→xlsx
  if (ext === 'docx') return 'doc';
  if (ext === 'markdown') return 'md';
  if (ext === 'xls') return 'xlsx';
  return ext;
}
