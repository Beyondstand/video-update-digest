import re
raw = open('pdf-palette.txt','rb').read()
text = None
for enc in ('utf-16','utf-16-le','utf-8','gb18030'):
    try:
        t = raw.decode(enc)
        if t.count('�') < 10:
            text = t
            print('OK enc:', enc)
            break
    except Exception:
        pass
if text is None:
    text = raw.decode('utf-8','replace')
open('pdf-clean.txt','w',encoding='utf-8').write(text)
print('len', len(text))
print('hex:', re.findall(r'#[0-9A-Fa-f]{6}', text)[:20])
print('rgb:', re.findall(r'RGB[^。\n]{0,30}', text)[:10])
