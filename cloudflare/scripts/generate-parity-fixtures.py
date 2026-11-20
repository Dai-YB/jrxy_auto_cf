"""只运行原源码中的纯业务规则，生成合成对照数据；不导入引擎、不联网、不读取真实账号。"""
import ast
import json
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def definitions(path, names):
    tree = ast.parse(path.read_text(encoding='utf-8'))
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    if len(selected) != len(names):
        raise RuntimeError('缺少目标规则：' + str(names))
    return compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec')


class DummyUtils:
    @staticmethod
    def getApis(_):
        return ['list', 'detail', 'submit']


namespace = {'Utils': DummyUtils, 'wiseLoginService': object, 'json': json}
exec(definitions(ROOT/'jrxy-engine/actions/autoSign.py', {'AutoSign'}), namespace)
AutoSign = namespace['AutoSign']
user = {'type': 2, 'lon': 116.123, 'lat': 39.456, 'address': '测试位置', 'abnormalReason': '', 'checkTitle': 1,
        'forms': [{'form': {'title': '健康状态', 'value': '正常'}}, {'form': {'title': '备注', 'value': '其他', 'extra': "测试'O\n中文"}}]}
task = {'isPhoto': 0, 'isNeedExtra': 1, 'isMalposition': 0, 'signInstanceWid': 'instance-1', 'extraField': [
    {'title': '健康状态', 'extraFieldItems': [{'content': '正常', 'isOtherItems': 0, 'isSelected': True, 'wid': 'item-1'}]},
    {'title': '备注', 'extraFieldItems': [{'content': '其他', 'isOtherItems': 1, 'isSelected': False, 'wid': 'item-2'}]}]}


class Response:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


class Session:
    headers = {}

    def __init__(self, data):
        self.data = data

    def post(self, *_, **__):
        return Response({'datas': self.data})


class Wise:
    campus_host = 'https://synthetic.example/'

    def __init__(self, data):
        self.session = Session(data)


sign = AutoSign(Wise({}), user)
sign.task = task
sign.fillForm()
fixture = {'form': {'user': user, 'task': task, 'expected': sign.form},
           'pythonStrings': [{'input': v, 'expected': str(v)} for v in [True, False, None, sign.form['extraFieldItems']]], 'selection': []}
for title in [None, '晚间', '不存在']:
    data = {'unSignedTasks': [
        {'taskName': '晚间查寝1', 'signInstanceWid': 'a', 'signWid': 'sa'},
        {'taskName': '晚间查寝2', 'signInstanceWid': 'b', 'signWid': 'sb'}], 'leaveTasks': [], 'signedTasks': []}
    config = dict(user)
    if title is not None:
        config['formTitle'] = title
    selected = AutoSign(Wise(data), config)
    selected.getUnSignTask()
    fixture['selection'].append({'user': config, 'list': data, 'expected': selected.taskInfo})
labels = {'success':'签到成功','already':'今日已签到','no_task':'暂无待签任务','dry':'探测通过','fail':'签到失败','error':'执行异常'}
ns = {'json':json,'RESULT_LABELS':labels}
exec(definitions(ROOT/'web-server/app.py', {'classify','parse_marker','notify_head'}),ns)
fixture['classification'] = []
for status, message in [('success','SUCCESS'),('dry','有待签任务'),('already','今日已签到：晚间查寝'),('fail','不在签到范围'),('error','连接失败'),('no_task','没有未签到的任务')]:
    out='###RESULT###'+json.dumps({'status':status,'msg':message},ensure_ascii=False)
    fixture['classification'].append({'input':{'status':status,'message':message},'expected':ns['classify'](out)})
fixture['signatureMaterial'] = []
for lon, lat in [(120.0, 30.0), (0.00001, -0.0), (116.123, 39.456)]:
    body = dict(sign.form, longitude=lon, latitude=lat)
    fixture['signatureMaterial'].append({'form': body, 'serialized': json.dumps(body, ensure_ascii=False),
        'sortedValues': ''.join(sorted(str(value) for value in body.values()))})
utils_tree = ast.parse((ROOT/'jrxy-engine/actions/utils.py').read_text(encoding='utf-8'))
utils_class = next(node for node in utils_tree.body if isinstance(node, ast.ClassDef) and node.name == 'Utils')
apis_method = next(node for node in utils_class.body if isinstance(node, ast.FunctionDef) and node.name == 'getApis')
apis_method.decorator_list = []
apis_namespace = {}
exec(compile(ast.Module(body=[apis_method], type_ignores=[]), 'original-api-paths', 'exec'), apis_namespace)
fixture['apis'] = [{'type': typ, 'paths': apis_namespace['getApis'](typ)[:3]} for typ in (1, 2)]
output = ROOT/'cloudflare/tests/fixtures/original-rules.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Generated synthetic expectations from original Python definitions; no network or account data used.')
