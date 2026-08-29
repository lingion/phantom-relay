import json, time, urllib.request, urllib.error, urllib.parse, websocket, subprocess, sys, os, base64
API='http://127.0.0.1:8765'

def status():
    return json.load(urllib.request.urlopen(API+'/browser/status', timeout=5))

def post_json(path, body, timeout=5):
    req=urllib.request.Request(API+path, data=json.dumps(body,ensure_ascii=False).encode(), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e:return e.code,json.loads(e.read().decode())

def cdp_page():
    items=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=5))
    return next(x for x in items if x.get('type')=='page' and 'chat.deepseek.com' in x.get('url',''))

def cdp_call(ws, n, method, params=None):
    n+=1; ws.send(json.dumps({'id':n,'method':method,'params':params or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get('id')==n:return n,r

def do_case(case):
    name=case['name']; model=case['model']; messages=case['messages']; idem='matrix-'+name+'-'+str(int(time.time()*1000))
    before={j for j in status().get('jobs',{})}
    body={'model':model,'messages':messages,'stream':False,'timeout':120}
    req=['curl','-sS','--max-time','150','-H','Content-Type: application/json','-H','Idempotency-Key: '+idem,API+'/v1/chat/completions','-d',json.dumps(body,ensure_ascii=False)]
    p=subprocess.Popen(req,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    job=None
    started=time.time()
    for _ in range(300):
        try:
            js=status().get('jobs',{})
            fresh=[]
            for jid,j in js.items():
                if jid not in before and j.get('model')==model:
                    try:num=int(jid.split('_')[1])
                    except:num=0
                    fresh.append((num,j))
            if fresh:
                job=max(fresh,key=lambda z:z[0])[1]
                if job.get('status')=='claimed':break
        except Exception:pass
        time.sleep(.5)
    result={'name':name,'model':model,'job':job and job.get('id'),'claimed':bool(job and job.get('status')=='claimed')}
    if model!='deepseek' or not result['claimed']:
        out,_=p.communicate(timeout=160); result['api_raw']=out[-2000:]; return result
    page=cdp_page(); ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=15); n=0
    n,_=cdp_call(ws,n,'Runtime.enable'); n,_=cdp_call(ws,n,'Page.enable')
    n,focus=cdp_call(ws,n,'Runtime.evaluate',{'expression':'(()=>{const e=document.querySelector("textarea");if(!e)return null;e.focus();return {v:e.value,active:document.activeElement===e}})()','returnByValue':True})
    result['focus']=focus.get('result',{}).get('result',{}).get('value')
    shot=cdp_call(ws,n,'Page.captureScreenshot',{'format':'png','fromSurface':True})[1]
    n+=1
    safe=name.replace('/','_')
    try:open(f'/Users/lingion_k/Desktop/phantom-relay/server/matrix-before-{safe}.png','wb').write(base64.b64decode(shot['result']['data']))
    except:pass
    n,_=cdp_call(ws,n,'Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
    n,_=cdp_call(ws,n,'Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
    expected=messages[-1]['content']; answer=''
    for i in range(75):
        time.sleep(2)
        n,r=cdp_call(ws,n,'Runtime.evaluate',{'expression':'document.body.innerText.slice(-2500)','returnByValue':True})
        text=r.get('result',{}).get('result',{}).get('value','')
        if expected in text:
            tail=text.split(expected)[-1].strip(); lines=[x.strip() for x in tail.splitlines() if x.strip()]
            junk={'快速模式','专家模式','识图模式','深度思考','智能搜索','内容由 AI 生成，请仔细甄别'}
            lines=[x for x in lines if x not in junk]
            if lines: answer=lines[0]
        if answer and answer!=expected:break
    result['assistant_seen']=answer
    shot=cdp_call(ws,n,'Page.captureScreenshot',{'format':'png','fromSurface':True})[1]; n+=1
    try:open(f'/Users/lingion_k/Desktop/phantom-relay/server/matrix-after-{safe}.png','wb').write(base64.b64decode(shot['result']['data']))
    except:pass
    ws.close()
    if answer and answer!=expected:
        q=urllib.parse.urlencode({'job_id':job['id'],'tab_id':str(job['tab_id']),'domain':'chat.deepseek.com','conversation_id':job.get('conversation_id','')})
        try:
            with urllib.request.urlopen(API+'/browser/result-token?'+q,timeout=5) as rr:
                code=rr.status; tok=json.loads(rr.read().decode())
        except urllib.error.HTTPError as ee:
            code=ee.code; tok=json.loads(ee.read().decode())
        result['token_status']=code
        if tok.get('claim_token'):
            payload={'job_id':job['id'],'claim_token':tok['claim_token'],'success':True,'user':expected,'assistant':answer,'conversation_id':job.get('conversation_id',''),'tab_id':job['tab_id'],'domain':'chat.deepseek.com','response_region':'matrix','completion_reason':'stable_snapshot'}
            result['result_status'],result['result_body']=post_json('/browser/result',payload,10)
    out,err=p.communicate(timeout=160); result['api_raw']=out[-4000:]; result['api_ok']='"choices"' in out and '"content"' in out
    return result

cases=[
 {'name':'short','model':'deepseek','messages':[{'role':'user','content':'请只回复：短测试通过'}]},
 {'name':'long','model':'deepseek','messages':[{'role':'user','content':'请阅读并只回复：长测试通过。背景：'+('这是用于验证长输入稳定性的测试句。'*180)}]},
 {'name':'multiturn','model':'deepseek','messages':[{'role':'user','content':'记住代号：蓝鲸-47。'}, {'role':'assistant','content':'好的，我记住了。'}, {'role':'user','content':'只回复你记住的代号。'}]},
 {'name':'boundary-empty-ish','model':'deepseek','messages':[{'role':'user','content':'请只回复：边界测试通过\n\n  。  '} ]},
 {'name':'switch-deepseek-1','model':'deepseek','messages':[{'role':'user','content':'请只回复：切换前通过'}]},
 {'name':'switch-doubao','model':'doubao','messages':[{'role':'user','content':'请只回复：切换到豆包通过'}]},
 {'name':'switch-deepseek-2','model':'deepseek','messages':[{'role':'user','content':'请只回复：切换回来通过'}]},
]
for c in cases[:4]:
    print(json.dumps(do_case(c),ensure_ascii=False),flush=True)
