"""从原Python入口生成合成HTTP请求轨迹。适配器和socket均拒绝真实网络，不读取账号文件。
隔离环境依赖：requests、beautifulsoup4、pycryptodome；用 python -I 运行。
"""
import argparse
import ast
import base64
import copy
import hashlib
import io
import json
import os
import re
import socket
import types
import urllib.parse
import uuid
from email.message import Message
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from Crypto.Cipher import AES, DES
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_v1_5
from Crypto.Util.Padding import pad

ROOT = Path(__file__).resolve().parents[2]
FIXED_UUID = '11111111-2222-4333-8444-555555555555'
SCHOOL = '请求对照模拟学校'
USER = {'schoolName': SCHOOL, 'username': 'student~*', 'password': "P a~*+&'example", 'type': 2,
        'lon': 120.125, 'lat': 30.5, 'address': '合成位置', 'abnormalReason': '', 'checkTitle': 0}
TASK = {'signInstanceWid': 'instance', 'signWid': 'sign', 'taskName': '模拟查寝', 'isPhoto': 0,
        'isNeedExtra': 0, 'isMalposition': 0, 'signPlaceSelected': [{'longitude': 120.125, 'latitude': 30.5, 'radius': 100, 'address': '合成位置'}]}


def deny_network(*_, **__):
    raise AssertionError('Fixture generation must never access the network')


socket.socket.connect = deny_network
socket.create_connection = deny_network


def load(path, names, namespace):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8'))
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    if len(selected) != len(names):
        raise RuntimeError('Original definition missing: ' + str(names))
    exec(compile(ast.Module(body=selected, type_ignores=[]), path, 'exec'), namespace)


class FixedUtils:
    randString = staticmethod(lambda length: 'A' * length)
    getCodeFromImg = staticmethod(lambda *_: (_ for _ in ()).throw(AssertionError('OCR is excluded')))
    checkStatus = staticmethod(lambda response, **_: deny_network() if response.status_code == 418 else None)
    md5 = staticmethod(lambda text: hashlib.md5(text.encode()).hexdigest())


tree = ast.parse((ROOT / 'jrxy-engine/actions/utils.py').read_text(encoding='utf-8'))
original_utils = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Utils')
for name in ['encryptAES', 'getApis']:
    method = next(node for node in original_utils.body if isinstance(node, ast.FunctionDef) and node.name == name)
    method.decorator_list = []
    ns = {'AES': AES, 'base64': base64}
    exec(compile(ast.Module(body=[method], type_ignores=[]), 'original-utils', 'exec'), ns)
    setattr(FixedUtils, name, staticmethod(ns[name]))


class Adapter(requests.adapters.BaseAdapter):
    def __init__(self, form):
        self.form = form
        self.calls = []
        self.login_pages = 0
        self.submitted = False

    def send(self, request, **options):
        body = request.body.decode('utf-8') if isinstance(request.body, bytes) else request.body
        selected_headers = {k.lower(): v for k, v in request.headers.items() if k.lower() not in ('content-length', 'accept-encoding', 'connection')}
        incoming = {'method': request.method, 'url': request.url, 'headers': selected_headers, 'body': body}
        response = self.reply(request)
        self.calls.append({'request': incoming, 'response': response, 'transport': {'verify': options.get('verify'), 'timeout': options.get('timeout')}})
        result = requests.Response()
        result.status_code = response['status']
        result.url = request.url
        result.request = request
        result.encoding = 'utf-8'
        result._content = response['body'].encode('utf-8')
        result._content_consumed = True
        message = Message()
        for key, value in response['headers']:
            message.add_header(key, value)
            result.headers[key] = value
        # 使用requests自己的Cookie与redirect实现，不自行模拟这部分规则。
        result.raw = types.SimpleNamespace(_original_response=types.SimpleNamespace(msg=message))
        return result

    def close(self):
        pass

    def reply(self, request):
        parsed = urllib.parse.urlparse(request.url)
        path = parsed.path
        headers = []
        status = 200
        if path.endswith('/tenant/list'):
            body = json.dumps({'data': [{'id': 'tenant', 'name': SCHOOL, 'joinType': 'CLOUD' if self.form == 'iap' else 'CAS'}]})
        elif path.endswith('/tenant/info'):
            body = json.dumps({'data': [{'joinType': 'CLOUD' if self.form == 'iap' else 'CAS', 'ampUrl': 'https://school.campusphere.net/portal', 'ampUrl2': ''}]})
        elif path == '/portal':
            status = 302
            service = urllib.parse.quote('https://school.campusphere.net/callback?sessionToken=synthetic-token', safe='')
            headers = [('Location', 'https://login.example.edu/authserver/login?service=' + service), ('Set-Cookie', 'portal=original; Path=/; Secure')]
            body = ''
        elif path == '/authserver/login' and request.method == 'GET':
            self.login_pages += 1
            token = 'token-' + str(self.login_pages)
            fields = '<input name="execution" value="' + token + '"><input name="duplicate" value="first"><input name="duplicate" value="last"><input name="username"><input name="password"><input name="rememberMe" value="true"><input name="special" value="a &amp; b~*!&apos;中"><input id="' + ('pwdDefaultEncryptSalt' if self.form == 'casLoginForm' else 'pwdEncryptSalt') + '" value="1234567890123456">'
            if self.form == 'iap':
                body = 'IAP login'
            else:
                body = '<input name="outside" value="whole-page-only">'
                if self.form == 'loginFromId':
                    body += '<form id="loginFromId"><input name="execution" value="wrong-first"></form>'
                body += '<form id="' + self.form + '">' + fields + '</form>'
            headers = [('Set-Cookie', 'session=c' + str(self.login_pages) + '; Domain=.example.edu; Path=/; Secure'),
                       ('Set-Cookie', 'flow=fixed; Path=/authserver; Expires=Wed, 01 Jan 2031 00:00:00 GMT')]
        elif path.endswith('/needCaptcha.html'):
            body = 'false'
        elif path.endswith('/checkNeedCaptcha.htl'):
            body = '{"isNeed":false}'
        elif path == '/iap/security/lt':
            body = '{"result":{"_lt":"synthetic-lt"}}'
        elif path == '/iap/checkNeedCaptcha':
            body = '{"needCaptcha":false}'
        elif path == '/iap/doLogin' or (path == '/authserver/login' and request.method == 'POST'):
            status = 302
            headers = [('Location', 'https://school.campusphere.net/callback'), ('Set-Cookie', 'CASTGC=synthetic-cas; Path=/; Secure')]
            body = ''
        elif path == '/callback':
            body = 'ok'
            headers = [('Set-Cookie', 'MOD_AUTH_CAS=synthetic-auth; Path=/; Secure')]
        elif path.endswith('getStuAttendacesInOneDay'):
            body = json.dumps({'datas': {'unSignedTasks': [] if self.submitted else [TASK], 'signedTasks': [TASK] if self.submitted else [], 'leaveTasks': []}})
        elif path.endswith('detailSignInstance'):
            body = json.dumps({'datas': TASK})
        elif path.endswith('getSecretKey/v-920'):
            encrypted = PKCS1_v1_5.new(RSA.import_key(protocol['NATIVE_PRIVATE_KEY_PEM']).publickey(), randfunc=lambda n: bytes([1]) * n).encrypt(b'random|loginraw|9hriwfra')
            body = json.dumps({'data': base64.b64encode(encrypted).decode()})
        elif path.endswith('submitSign'):
            self.submitted = True
            body = '{"message":"SUCCESS"}'
        else:
            raise AssertionError('Unexpected synthetic target: ' + path)
        return {'status': status, 'headers': headers, 'body': body}


protocol = {'AES': AES, 'DES': DES, 'RSA': RSA, 'PKCS1_v1_5': PKCS1_v1_5, 'pad': pad,
            'base64': base64, 'json': json, 'hashlib': hashlib, 'Utils': FixedUtils,
            'uuid': types.SimpleNamespace(uuid4=lambda: uuid.UUID(FIXED_UUID)),
            'os': types.SimpleNamespace(urandom=lambda n: bytes(n)), 'print': lambda *_, **__: None}
protocol_tree = ast.parse((ROOT / 'jrxy-engine/scripts/merged_ios_v4_submit.py').read_text(encoding='utf-8'))
for statement in protocol_tree.body:
    if isinstance(statement, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in statement.targets):
        exec(compile(ast.Module(body=[statement], type_ignores=[]), 'protocol-constants', 'exec'), protocol)
load('jrxy-engine/scripts/merged_ios_v4_submit.py', {'SecretError','fetch_secrets','key_candidates','interleave','aes_cbc_pkcs7_b64','rsa_encrypt','rsa_decrypt_text','des_b64','submit_ios_v4','_main'}, protocol)


class Args:
    def __init__(self, mode):
        self.mode = mode
    def add_argument(self, *_, **__):
        pass
    def parse_args(self):
        return types.SimpleNamespace(config='synthetic.yml', device_id='fixed-device', lon=None, lat=None, address=None,
                                     submit=self.mode == 'submit', variant='fkey_cat', max_tries=1, protocol='ios', userid=None, sign_mode='hash')


def capture(form, mode):
    adapter = Adapter(form)
    scope = {'Utils': FixedUtils, 'BeautifulSoup': BeautifulSoup, 'urllib': urllib, 're': re, 'json': json,
             'requests': requests, 'HTTP_TIMEOUT': (10, 30), 'HTTPAdapter': requests.adapters.HTTPAdapter,
             'Retry': requests.packages.urllib3.util.retry.Retry, 'print': lambda *_, **__: None}
    load('jrxy-engine/actions/wiseLoginService.py', {'TimeoutSession', 'new_session'}, scope)
    original_session = scope['new_session']
    def session():
        result = original_session()
        result.trust_env = False
        result.mount('https://', adapter)
        result.mount('http://', adapter)
        return result
    scope['new_session'] = session
    load('jrxy-engine/actions/casLogin.py', {'casLogin'}, scope)
    load('jrxy-engine/actions/iapLogin.py', {'iapLogin'}, scope)
    load('jrxy-engine/actions/wiseLoginService.py', {'wiseLoginService'}, scope)
    load('jrxy-engine/actions/autoSign.py', {'AutoSign'}, scope)
    results = []
    common = {**scope, 'argparse': types.SimpleNamespace(ArgumentParser=lambda: Args(mode)),
              'yaml': types.SimpleNamespace(safe_load=lambda _: {'users': [{'user': copy.deepcopy(USER)}]}),
              'open': lambda *_, **__: io.StringIO('synthetic'), '__file__': str(ROOT / 'jrxy-engine/scripts/synthetic.py'),
              'os': types.SimpleNamespace(path=os.path, getenv=lambda _: None, urandom=lambda n: bytes(n)),
              'sys': types.SimpleNamespace(exit=lambda code: (_ for _ in ()).throw(AssertionError('Unexpected exit: ' + str(code)))),
              'emit_result': lambda status, msg: results.append(status), 'time': types.SimpleNamespace(sleep=lambda _: None)}
    if mode in ('dry', 'submit'):
        common = {**protocol, **common}
        load('jrxy-engine/scripts/merged_ios_v4_submit.py', {'_main'}, common)
        common['_main']()
    else:
        # main内部import argparse只读取合成参数；不影响其他模块或访问文件。
        tree = ast.parse((ROOT / ('jrxy-engine/scripts/test_login.py' if mode == 'login' else 'jrxy-engine/scripts/fetch_sign_range.py')).read_text(encoding='utf-8'))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        main.body = [node for node in main.body if not isinstance(node, ast.Import)]
        exec(compile(ast.Module(body=[main], type_ignores=[]), 'original-entry', 'exec'), common)
        common['main']()
    expected={'login':8,'range':10,'dry':17,'submit':18}[mode]
    if len(adapter.calls)!=expected:
        raise AssertionError('Original entry stopped early: '+form+':'+mode)
    if mode in ('dry','submit') and results!=[mode if mode=='dry' else 'success']:
        raise AssertionError('Original entry did not reach success')
    # RSA请求使用随机填充，保留其结构而非要求随机密文逐字相等。
    for call in adapter.calls:
        if '/getSecretKey/' in call['request']['url']:
            data = json.loads(call['request']['body'])
            if len(base64.b64decode(data['p'])) != 128:
                raise AssertionError('Unexpected RSA request size')
            data['p'] = '<RSA ciphertext>'
            call['request']['body'] = json.dumps(data)
    return {'name': form + ':' + mode, 'form': form, 'mode': mode, 'user': USER, 'deviceId': 'fixed-device', 'calls': adapter.calls}


if __name__ == '__main__':
    result = {'uuid': FIXED_UUID, 'cases': [capture(form, mode) for form in ['casLoginForm','pwdFromId','loginFromId','iap'] for mode in ['login','range','dry','submit']]}
    output = ROOT / 'cloudflare/tests/fixtures/original-http.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Generated 16 traces from original Python entry points; all HTTP is synthetic, socket access disabled.')
