import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
for r in reversed(rows):
    c=(r.get('message') or {}).get('content')
    if isinstance(c,list):
        hit=[x for x in c if x.get('type')=='tool_result']
        if hit:
            x=hit[0]; print(r.get('timestamp','')[11:19], 'is_error=',x.get('is_error'), '|', x.get('content') if isinstance(x.get('content'),str) else json.dumps(x.get('content'))); break
