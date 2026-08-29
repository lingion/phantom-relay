#!/usr/bin/env python3
import argparse, json, time, urllib.request, websocket

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--domain',default='chat.deepseek.com'); ap.add_argument('--seconds',type=float,default=35); ap.add_argument('--prompt',default='请只回复：网络流格式探针')
    a=ap.parse_args(); pages=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=5)); p=next(x for x in pages if x.get('type')=='page' and a.domain in x.get('url',''))
    ws=websocket.create_connection(p['webSocketDebuggerUrl'],timeout=8); seq=[0]
    def call(m,params=None):
        seq[0]+=1; i=seq[0]; ws.send(json.dumps({'id':i,'method':m,'params':params or {}}))
        while True:
            r=json.loads(ws.recv())
            if r.get('id')==i:return r
    call('Network.enable'); call('Runtime.enable'); call('Input.setIgnoreInputEvents',{'ignore':False})
    call('Runtime.evaluate',{'expression':"(()=>{const e=document.querySelector('textarea,[contenteditable=\\\"true\\\"],[role=\\\"textbox\\\"]');if(!e)return false;e.focus();return true})()"})
    call('Input.insertText',{'text':a.prompt}); call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13}); call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
    target=None; end=time.time()+a.seconds; ws.settimeout(1)
    while time.time()<end:
        try:e=json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:continue
        if e.get('method')=='Network.responseReceived':
            r=e['params']['response']; u=r.get('url','')
            if '/chat/completion' in u: target=e['params']['requestId']; print('STREAM',r.get('mimeType'),r.get('status'),u)
        if e.get('method')=='Network.loadingFinished' and target and e['params'].get('requestId')==target:
            r=call('Network.getResponseBody',{'requestId':target}); body=r.get('result',{}).get('body',''); print('BODY_LEN',len(body));
            for line in body.splitlines():
                if not line.startswith('data:'): continue
                raw=line[5:].strip()
                if raw=='[DONE]': print('DONE'); continue
                try:
                    obj=json.loads(raw); print('EVENT_KEYS',sorted(obj.keys()),'DATA_KEYS',sorted(obj.get('data',{}).keys()) if isinstance(obj.get('data'),dict) else type(obj.get('data')).__name__,'TEXT_LENGTHS',[len(str(v)) for k,v in obj.items() if isinstance(v,str) and k not in ('id','type')])
                except: print('NONJSON_DATA_LEN',len(raw))
            break
    ws.close()
if __name__=='__main__':main()
