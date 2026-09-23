# 走查第三波驱动：全流水线实机脚本（问题逐条打印，结果落台账）
import json, time, hashlib, urllib.request, uuid, sys

PID = '774e76d6-a6fd-4d64-9238-850917969ef2'
BASE = f'http://localhost:8080/api/v1/projects/{PID}'
ROOT = 'http://localhost:8080'

def req(method, path, body=None, raw=None, base=None, timeout=120):
    data = raw if raw is not None else (json.dumps(body).encode('utf-8') if body is not None else None)
    r = urllib.request.Request((base or BASE) + path, data=data, method=method)
    if raw is None and data is not None:
        r.add_header('Content-Type', 'application/json')
    if raw is not None:
        r.add_header('Content-Type', 'application/octet-stream')
    if method in ('POST', 'DELETE'):
        r.add_header('Idempotency-Key', str(uuid.uuid4()))
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.getcode(), json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8') or '{}')
        except Exception:
            return e.code, {}

def upload(path, name=None):
    content = open(path, 'rb').read()
    name = name or path.split('/')[-1].split('\\')[-1]
    sha = hashlib.sha256(content).hexdigest()
    c, b = req('POST', '/materials/uploads', {'fileName': name, 'size': len(content), 'sha256': sha})
    assert c == 201, (c, b)
    uid = b['uploadId']
    c, x = req('PUT', f'/materials/uploads/{uid}/parts/1', raw=content)
    assert c in (200, 201), (c, x)
    c, b = req('POST', f'/materials/uploads/{uid}:complete', {})
    assert c == 200, (c, b)
    return b['file']['id']

def wait_file_status(fid, wants, tries=120, gap=2):
    for _ in range(tries):
        c, b = req('GET', f'/materials/files/{fid}?view=parsed')
        if b.get('status') in wants:
            return b
        time.sleep(gap)
    raise SystemExit(f'timeout waiting {wants} for {fid}, last={b.get("status")}')

def chat(session_id, content, refs=None, fps=None, think=None, timeout=900, verbose=True):
    """发送消息并消费 SSE，返回 (frames, full_text, tool_frames)"""
    import urllib.request as _u
    url = f'{BASE}/ai/sessions/{session_id}/messages:send'
    body = {'content': content}
    if refs: body['referenceFileIds'] = refs
    if fps: body['referenceFingerprints'] = fps
    if think: body['thinkLevel'] = think
    r = _u.Request(url, data=json.dumps(body).encode('utf-8'), method='POST')
    r.add_header('Content-Type', 'application/json')
    r.add_header('Idempotency-Key', str(uuid.uuid4()))
    resp = _u.urlopen(r, timeout=timeout)
    frames, text_parts, tools = [], [], []
    buf = b''
    while True:
        chunk = resp.read(1)
        if not chunk:
            break
        buf += chunk
        while b'\n\n' in buf:
            frame, buf = buf.split(b'\n\n', 1)
            line = frame.decode('utf-8', 'replace')
            if not line.startswith('data: '):
                continue
            ev = json.loads(line[6:])
            frames.append(ev)
            t = ev.get('type')
            if t == 'stream.delta':
                text_parts.append(ev.get('text', ''))
            elif t != 'stream.start':
                tools.append(ev)
                if verbose:
                    print('  [frame]', t, json.dumps({k: v for k, v in ev.items() if k != 'type'}, ensure_ascii=False)[:300])
            if t in ('stream.done', 'stream.error'):
                return frames, ''.join(text_parts), tools
    return frames, ''.join(text_parts), tools
