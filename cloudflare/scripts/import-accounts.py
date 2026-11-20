"""旧账号迁移工具：默认只检查，不上传；--apply 才将配置导入指定部署。
依赖原项目已有 PyYAML。请从项目根目录或其他可信目录通过 python -I 运行。
"""
import argparse
import json
import http.cookiejar
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--accounts', required=True, help='旧 accounts 目录')
    parser.add_argument('--url', help='目标管理台 HTTPS 地址；本地开发可用 http://127.0.0.1:8787')
    parser.add_argument('--apply', action='store_true', help='明确授权将账号凭据上传到 --url，默认只检查')
    args = parser.parse_args()
    try:
        import yaml
    except ImportError:
        parser.error('缺少 PyYAML，请使用原项目 Python 环境或安装 PyYAML')
    folder = Path(args.accounts).resolve()
    if not folder.is_dir():
        parser.error('accounts 目录不存在')
    url = (args.url or '').rstrip('/')
    admin_user = os.environ.get('JRXY_ADMIN_USERNAME', '')
    admin_password = os.environ.get('JRXY_ADMIN_PASSWORD', '')
    if args.apply:
        parsed = urllib.parse.urlparse(url)
        if not url or (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost'))):
            parser.error('--apply 需要目标 HTTPS 地址或本机测试地址')
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error('目标地址不能包含用户名、密码、查询参数或片段')
        if parsed.path not in ('', '/'):
            parser.error('目标应为管理台根域名，不要带页面路径')
        if not admin_user or not admin_password:
            parser.error('请通过 JRXY_ADMIN_USERNAME / JRXY_ADMIN_PASSWORD 环境变量提供管理员账号密码，不要放在命令参数中')
    prepared = []
    errors = []
    for path in sorted(folder.glob('*.yml')):
        if path.name.startswith('_'):
            continue
        try:
            data = yaml.safe_load(path.read_text(encoding='utf-8-sig'))
            user = data['users'][0]['user']
            if int(user.get('type', 2)) not in (1, 2):
                print(f'跳过 {path.stem}：不是签到/查寝类型')
                continue
            device_file = path.with_suffix('.device_id')
            if not device_file.is_file() or not device_file.read_text(encoding='utf-8-sig').strip():
                raise ValueError('缺少原 .device_id，必须先从本人设备提取，禁止随机生成')
            body = {key: user[key] for key in ('schoolName', 'username', 'password', 'type', 'lon', 'lat', 'address',
                    'abnormalReason', 'checkTitle', 'formTitle', 'forms') if key in user}
            body.update(name=path.stem, deviceId=device_file.read_text(encoding='utf-8-sig').strip(),
                        notifyOption=user.get('notifyOption') or {}, httpProxy=user.get('httpProxy') or data.get('httpProxy') or '')
            prepared.append(body)
            print(f'通过 {path.stem}：原设备绑定保留，敏感字段不打印')
            if body['httpProxy']:
                print('  注意：配置包含HTTP代理；当前纯Workers适配尚未支持，不会静默忽略。')
        except Exception as error:
            # 不输出 YAML/网络异常原文，可能带密码或原配置内容。
            errors.append(path.stem)
            print(f'失败 {path.stem}：配置不完整、格式错误或缺少原设备ID（{type(error).__name__}）')
    if errors:
        print('存在无效配置，未执行任何上传。请修复后重试。')
        return 1
    print(f'检查完成：{len(prepared)} 个账号；' + ('开始按显式 --apply 导入。' if args.apply else '只检查，未联网、未上传、未生成明文导出文件。'))
    if not args.apply:
        return 0
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(cookies))
    try:
        login_request = urllib.request.Request(url + '/api/auth/login',
            data=json.dumps({'username': admin_user, 'password': admin_password}).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Origin': url}, method='POST')
        with opener.open(login_request, timeout=30) as response:
            csrf_token = json.loads(response.read(32768))['csrfToken']
    except Exception:
        print('管理员登录失败，未上传任何账号。请核对凭据、目标地址或稍后重试。')
        return 1
    failures = 0
    for body in prepared:
        request = urllib.request.Request(url + '/api/accounts', data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                  headers={'Content-Type': 'application/json', 'Origin': url, 'X-CSRF-Token': csrf_token}, method='POST')
        try:
            with opener.open(request, timeout=30) as response:
                response.read(32768)
            print(f'导入成功：{body["name"]}')
        except urllib.error.HTTPError as error:
            failures += 1
            print(f'导入失败：{body["name"]}，HTTP {error.code}；已有账号不会被覆盖，请在管理台检查')
        except Exception:
            failures += 1
            print(f'导入结果待确认：{body["name"]}；网络响应异常，请在管理台核实，不自动重复上传')
    try:
        logout = urllib.request.Request(url + '/api/auth/logout', data=b'{}',
            headers={'Content-Type': 'application/json', 'Origin': url, 'X-CSRF-Token': csrf_token}, method='POST')
        with opener.open(logout, timeout=15) as response:
            response.read(32768)
    except Exception:
        print('管理会话退出请求未确认，会话将按服务端过期时间失效。')
    print('导入结束；未启动学校登录、探测、签到或通知。')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
