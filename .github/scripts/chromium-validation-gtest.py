"""Validate named completed gtests, including Chromium launcher aggregate JSON."""
import argparse,json,pathlib,re
p=argparse.ArgumentParser();p.add_argument('prefix');p.add_argument('--exit',type=int,required=True)
p.add_argument('--expect-failure',action='store_true');p.add_argument('--require',action='append',default=[])
p.add_argument('--failure-test',default='SameSizeParentSurfaceBlocksStaleFrames')
p.add_argument('--failure-text',default='obsolete surface submitted during parent handoff')
a=p.parse_args();prefix=pathlib.Path(a.prefix);launcher=pathlib.Path(str(prefix)+'.launcher.json')
source=launcher if launcher.exists()else pathlib.Path(str(prefix)+'.json')
data=json.loads(source.read_text());cases=[]
if 'per_iteration_data'in data:
    iterations=data['per_iteration_data'];assert len(iterations)==1,'No repeated iterations'
    for name,attempts in iterations[0].items():
        assert len(attempts)==1,('No test retries',name,len(attempts))
        case=attempts[0];status=case['status'];assert status in ['SUCCESS','FAILURE'],(name,status)
        cases.append((name,status,json.dumps(case)))
else:
    def walk(value,suite=''):
        if isinstance(value,dict):
            if 'name'in value and ('status'in value or 'result'in value):
                assert value.get('status','RUN')=='RUN'
                assert value.get('result','COMPLETED')=='COMPLETED'
                name=value.get('classname',suite)+'.'+value['name']
                cases.append((name,'FAILURE'if value.get('failures')else'SUCCESS',json.dumps(value)))
            for key,item in value.items():
                walk(item,value.get('name',suite)if key in ['testsuite','testsuites']else suite)
        elif isinstance(value,list):
            for item in value:walk(item,suite)
    walk(data);assert int(data['tests'])==len(cases)
assert cases,'No actual completed tests'
for required in a.require:assert any(required in name for name,_,_ in cases),('Missing test',required)
if a.expect_failure:
    assert a.exit==1,('Expected assertion exit1, not crash/timeout/other exit',a.exit)
    assert len(cases)==1 and cases[0][1]=='FAILURE',cases
    assert a.failure_test in cases[0][0]
    assert re.search(a.failure_text,cases[0][2]),('Wrong assertion failure',cases[0][0])
else:
    assert a.exit==0 and all(status=='SUCCESS'for _,status,_ in cases),(a.exit,cases)
summary={'validated':True,'expectedAssertionFailure':a.expect_failure,'source':str(source),
         'testNames':[name for name,_,_ in cases],'exitCode':a.exit}
pathlib.Path(str(prefix)+'.validation.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary))
