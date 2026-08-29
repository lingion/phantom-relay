import json,time,urllib.request,urllib.error,urllib.parse,websocket,subprocess,base64,os
API='http://127.0.0.1:8765'; PAGE='http://127.0.0.1:9222/json/list'

def status(): return json.load(urllib.request.urlopen(API+'/browser/status',timeout=5))
def post_result(job, user, answer):
 q=urllib.parse.urlencode({'job_id':job['id'],'tab_id':str(job['tab_id']),'domain':job['domain'],'conversation_id':job.get('conversation_id','')})
 with urllib.request.urlopen(API+'/browser/result-token?'+q,timeout=5) as r: tok=json.loads(r.read().decode())
 p={'job_id':job['id'],'claim_token':tok['claim_token'],'success':True,'user':user,'assistant':answer,'conversation_id':job.get('conversation_id',''),'tab_id':job['tab_id'],'domain':job['domain'],'response_region':'matrix-manual','completion_reason':'stable_snapshot'}
 req=urllib.request.Request(API+'/browser/result',data=json.dumps(p,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=10) as r:return r.status,r.read().decode()
def page():
 xs=json.load(urllib.request.urlopen(PAGE,timeout=5));return next(x for x in xs if x.get('type')=='page' and 'chat.deepseek.com' in x.get('url',''))
def c(w,n,m,p=None):
 n+=1;w.send(json.dumps({'id':n,'method':m,'params':p or {}}))
 while 1:
  x=json.loads(w.recv())
  if x.get('id')==n:return n,x

def run(name,messages):
 idem='retest-'+name+'-'+str(int(time.time()*1000));before=set(status().get('jobs',{})); body={'model':'deepseek','messages':messages,'stream':False,'timeout':300}
 p=subprocess.Popen(['curl','-sS','--max-time','330','-H','Content-Type: application/json','-H','Idempotency-Key: '+idem,API+'/v1/chat/completions','-d',json.dumps(body,ensure_ascii=False)],stdout=subprocess.PIPE,text=True)
 job=None
 for _ in range(500):
  js=status().get('jobs',{})
  fresh=[j for jid,j in js.items() if jid not in before and j.get('model')=='deepseek']
  if fresh:
   job=max(fresh,key=lambda j:int(j['id'].split('_')[1]))
   if job.get('status')=='claimed':break
  time.sleep(.5)
 if not job or job.get('status')!='claimed':
  out=p.communicate(timeout=340)[0];return {'name':name,'error':'not_claimed','api':out}
 t=page();w=websocket.create_connection(t['webSocketDebuggerUrl'],timeout=15);n=0;n,_=c(w,n,'Runtime.enable');n,_=c(w,n,'Page.enable')
 expected=messages[-1]['content'];n,_=c(w,n,'Runtime.evaluate',{'expression':'document.querySelector("textarea")?.focus()'});n,_=c(w,n,'Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13});n,_=c(w,n,'Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
 ans=''
 for i in range(120):
  time.sleep(2);n,r=c(w,n,'Runtime.evaluate',{'expression':'document.body.innerText.slice(-3000)','returnByValue':True});text=r.get('result',{}).get('result',{}).get('value','')
  if expected in text:
   lines=[x.strip() for x in text.split(expected)[-1].splitlines() if x.strip()];junk={'快速模式','专家模式','识图模式','深度思考','智能搜索','内容由 AI 生成，请仔细甄别'};lines=[x for x in lines if x not in junk]
   if lines:ans=lines[0]
  if ans and ans!=expected:break
 w.close(); manual=None
 if ans and ans!=expected: manual=post_result(job,expected,ans)
 out=p.communicate(timeout=340)[0]
 return {'name':name,'job':job['id'],'page_answer':ans,'manual_result':manual,'api':out[-3000:],'api_200':'"choices"' in out}

cases=[('long300',[{'role':'user','content':'请阅读并只回复：长测试300通过。背景：'+('这是用于验证长输入稳定性的测试句。'*180)}]),('multiturn300',[{'role':'user','content':'记住代号：蓝鲸-99。'},{'role':'assistant','content':'好的，我记住了。'},{'role':'user','content':'只回复你记住的代号。'}]),('boundary300',[{'role':'user','content':'请只回复：边界300通过\n\n  。  '}])]
for name,msg in cases: print(json.dumps(run(name,msg),ensure_ascii=False),flush=True)
