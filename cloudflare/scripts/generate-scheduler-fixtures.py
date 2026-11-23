"""从原 _fire 提取合成调度轨迹；不加载原服务、不读取账号或访问网络。"""
import argparse
import ast
import json
import socket
import types
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def deny_network(*_, **__):
    raise AssertionError('Scheduler fixtures must never access the network')


socket.socket.connect = deny_network
socket.create_connection = deny_network
source = ast.parse((ROOT / 'web-server/app.py').read_text(encoding='utf-8'))
functions = ['_fire', 'is_exec_error', 'notify_head', 'summarize']
selected = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in functions]
assert len(selected) == len(functions)
default = next(node.value.args[0].args[1].value for node in source.body
               if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'MAX_RETRIES' for t in node.targets))


def scenario(name, outcomes):
    start = datetime(2026, 1, 1, 22, 5)
    clock = [start]
    events, attempts = [], {}

    def sleep(seconds):
        clock[0] += timedelta(seconds=seconds)

    def wait_until(due):
        events.append({'kind': 'wait', 'at': int((clock[0]-start).total_seconds()), 'due': int((due-start).total_seconds())})
        clock[0] = max(clock[0], due)

    def run(account, dry, trigger, will_retry=False):
        index = attempts.get(account, 0)
        attempts[account] = index + 1
        result = outcomes[account][min(index, len(outcomes[account])-1)]
        events.append({'kind': 'run', 'account': account, 'at': int((clock[0]-start).total_seconds()), 'attempt': index+1})
        return result, 'synthetic'

    namespace = dict(datetime=datetime, timedelta=timedelta, SLOT_FMT='%Y-%m-%d %H:%M', TZ_OFFSET=8,
                     now=lambda: clock[0], scheduler_state={}, save_schedule=lambda: None,
                     save_log=lambda *_: None, list_accounts=lambda: list(outcomes), run_and_report=run,
                     MAX_RETRIES=5, RETRY_DELAY_MINUTES=5, ACCOUNT_INTERVAL=10,
                     _wait_until=wait_until, time=types.SimpleNamespace(sleep=sleep),
                     log=types.SimpleNamespace(info=lambda *_: None, exception=lambda *_: None))
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'original-scheduler', 'exec'), namespace)
    namespace['_fire'](start)
    return {'name': name, 'outcomes': outcomes, 'events': events, 'attempts': attempts,
            'summary': namespace['scheduler_state']['last_result']}


result = {'source': 'web-server/app.py:_fire', 'originalDefaultRetries': int(default), 'requestedRetries': 5,
          'scenarios': [scenario('recover', {'a': ['执行异常']*5+['签到成功'], 'b': ['签到成功'], 'c': ['签到失败'], 'd': ['执行异常', '签到成功']}),
                        scenario('exhaust', {'a': ['执行异常'], 'b': ['暂无待签任务'], 'c': ['今日已签到']})]}
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('Generated original scheduler traces: two synthetic scenarios, five extra retries, no network.')
