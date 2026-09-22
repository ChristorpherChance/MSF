# M6 出口门禁①：真实模型 PRD 生成端到端（一次性冒烟脚本）
import hashlib, json, urllib.request, uuid

BASE = 'http://localhost:8080'
PID = 'c24dfa85-42ff-4f26-b091-6821b5266dda'

def req(method, path, body=None, raw=None, stream=False):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('Idempotency-Key', str(uuid.uuid4()))
    data = raw
    if raw is not None:
        r.add_header('Content-Type', 'application/octet-stream')
    if body is not None:
        r.add_header('Content-Type', 'application/json')
        data = json.dumps(body).encode()
    return urllib.request.urlopen(r, data=data, timeout=300)

def j(method, path, body=None):
    try:
        with req(method, path, body) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        print(f'HTTP {e.code} {method} {path}: {detail}')
        return {'_error': e.code}

# 1) 上传资料
content = ('# 喀麦隆门户需求资料\n\n建设面向市民的政务门户：新闻公告、在线办事（9 个流程）、'
           '状态追踪、多语言（法/英）。非功能：可用性 99.5%，移动端适配。\n').encode()
sha = hashlib.sha256(content).hexdigest()
up = j('POST', f'/api/v1/projects/{PID}/materials/uploads',
       {'fileName': 'portal-req.md', 'size': len(content), 'sha256': sha})
print('upload:', up)
uid = up['uploadId'] if 'uploadId' in up else up.get('id')
with req('PUT', f'/api/v1/projects/{PID}/materials/uploads/{uid}/parts/1', raw=content) as r:
    r.read()
done = j('POST', f'/api/v1/projects/{PID}/materials/uploads/{uid}:complete', {})
fid = done['file']['id']
print('file:', fid)

# 2) 解析 → 内容定稿
print('parse:', j('POST', f'/api/v1/projects/{PID}/materials/files/{fid}:parse', {}))
import time
f = None
for _ in range(30):
    f = j('GET', f'/api/v1/projects/{PID}/materials/files/{fid}')
    st = f.get('parseStatus') or f.get('parse_status')
    if st in ('parsed', 'failed'):
        break
    time.sleep(1)
print('file view keys:', list(f.keys()))
print('file:', json.dumps(f, ensure_ascii=False)[:500])
print('finalize-file:', j('POST', f'/api/v1/projects/{PID}/materials/files/{fid}:finalize-file', {}))
f = j('GET', f'/api/v1/projects/{PID}/materials/files/{fid}')
fp = f.get('contentFingerprint') or f.get('content_fingerprint')
md = f.get('parsedMd') or '# 喀麦隆门户需求资料\n\n（同上）'
print('save content-draft:', j('PUT', f'/api/v1/projects/{PID}/materials/files/{fid}/content-draft',
      {'contentMd': md, 'baseFingerprint': fp}))
print('finalize-content:', j('POST', f'/api/v1/projects/{PID}/materials/files/{fid}:finalize-content',
      {'confirm': True}))

refs = j('GET', f'/api/v1/projects/{PID}/materials/references')
print('references:', refs)
fp = refs['items'][0].get('fingerprint') or refs['items'][0]['contentFingerprint']

# 3) CRD 自举 → 编辑 → 提交 → 定稿
docs = j('GET', f'/api/v1/projects/{PID}/requirements/docs')
print('docs:', [(d.get('kind'), d.get('cur')) for d in (docs.get('items') or docs)])
crd = j('GET', f'/api/v1/projects/{PID}/requirements/docs/crd')
sec0 = crd['secs'][0]['secId'] if 'secId' in crd['secs'][0] else crd['secs'][0]['id']
j('POST', f'/api/v1/projects/{PID}/requirements/docs/crd/draft',
  {'secId': sec0, 'md': '# 引言\n\n喀麦隆政务门户建设项目客户需求文档（CRD）。',
   'baseVersion': crd['cur'], 'baseFingerprint': crd['contentFingerprint']})
cv = j('POST', f'/api/v1/projects/{PID}/requirements/docs/crd/versions:commit',
       {'message': 'CRD v1', 'baseVersion': crd['cur']})
print('commit:', cv)
fin = j('POST', f"/api/v1/projects/{PID}/requirements/docs/crd/versions/{cv['v']}:finalize",
        {'baseVersion': crd['cur'], 'confirm': True})
print('finalize:', fin)

# 4) PRD 真实生成（SSE）
with req('POST', f'/api/v1/projects/{PID}/requirements/docs/prd:generate',
         {'referenceFileIds': [fid], 'referenceFingerprints': {fid: fp},
          'instruction': '基于参考资料生成 PRD 初稿'}, stream=True) as r:
    acc = ''
    for line in r:
        s = line.decode('utf-8', 'replace').strip()
        if not s.startswith('data:'):
            continue
        fr = json.loads(s[5:].strip())
        if fr['type'] == 'stream.delta':
            acc += fr.get('text', '')
        else:
            print('frame:', json.dumps(fr, ensure_ascii=False)[:300])
print('=== PRD 生成完成，长度', len(acc), '===')
print(acc[:800])
