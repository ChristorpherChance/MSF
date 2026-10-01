import { useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../../api';
import { toast } from '../../ui/toast';
import { uploadFile } from './api';
import { useMaterialView } from './store';

/** 上传区（§3.2：点击/拖拽 + 隐藏 input[multiple]；三段式会话，ZIP 整包拒绝服务端裁决） */
export function UploadZone() {
  const { projectId, refresh } = useMaterialView();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doUpload = async (files: FileList | File[]) => {
    if (!projectId || files.length === 0) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        setProgress(`上传中 ${file.name}…`);
        // W2-018：内容寻址去重命中要显性告知（同内容不同名时用户看到的不是所传文件名）
        const r = await uploadFile(projectId, file, (done, total) =>
          setProgress(total > 1 ? `上传中 ${file.name}（${done}/${total} 片）…` : `上传中 ${file.name}…`),
        );
        if (r.deduped) {
          toast(`「${file.name}」与既有文件 ${r.code ?? ''}「${r.name ?? ''}」内容相同，已复用（未重复建行）`, 'success');
        }
      } catch (e) {
        // ZIP 十五步校验失败等：整包拒绝，行内列原因（REQ-103 不产半截数据）
        setError(e instanceof ApiError ? `${file.name}：${e.message}` : `${file.name}：上传失败`);
      }
    }
    setProgress(null);
    await refresh();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void doUpload(e.dataTransfer.files);
  };

  return (
    <div
      className={`upload-zone${drag ? ' drag' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      role="button"
      aria-label="上传资料文件"
    >
      点击或拖拽上传（doc/docx/pdf/xlsx/md/txt/zip）
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".doc,.docx,.pdf,.xlsx,.xls,.md,.markdown,.txt,.zip"
        onChange={(e) => {
          if (e.target.files) void doUpload(e.target.files);
          e.target.value = '';
        }}
      />
      {progress && <div className="up-prog">{progress}</div>}
      {error && <div className="up-err">{error}</div>}
    </div>
  );
}
