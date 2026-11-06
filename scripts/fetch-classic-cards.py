"""Download verified public-domain Rider-Waite-Smith images from Wikimedia Commons.

Uses HTTPS_PROXY / HTTP_PROXY when provided. Does not modify images.
The Commons-provided 640px thumbnails are bundled for responsive app display.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

OUT = Path(__file__).resolve().parents[1] / 'web/public/cards/classic'
HEADERS = {'User-Agent': 'AstralHub/0.2 (personal tarot application; public-domain Commons assets)'}
MAJORS = ['Fool','Magician','High_Priestess','Empress','Emperor','Hierophant','Lovers','Chariot','Strength','Hermit','Wheel_of_Fortune','Justice','Hanged_Man','Death','Temperance','Devil','Tower','Star','Moon','Sun','Judgement','World']
ITEMS = [(f'major-{i}',f'RWS_Tarot_{i:02d}_{name}.jpg') for i,name in enumerate(MAJORS)]
ITEMS += [(f'{suit}-{i}',f'{prefix}{i:02d}.jpg') for suit,prefix in [('wands','Wands'),('cups','Cups'),('swords','Swords'),('pentacles','Pents')] for i in range(1,15)]

def request(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=40) as response:
                return response.read(),response.headers.get('Content-Type','')
        except Exception:
            if attempt==3:raise
            time.sleep(2*(attempt+1))

def plain(text):
    return re.sub('<[^>]+>','',text).strip()

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    metadata={}
    for offset in range(0,len(ITEMS),26):
        group=ITEMS[offset:offset+26]
        query=urllib.parse.urlencode({'action':'query','format':'json','formatversion':'2','prop':'imageinfo','iiprop':'url|extmetadata|sha1|size','iiurlwidth':'640','titles':'|'.join('File:'+file for _,file in group)})
        data=json.loads(request('https://commons.wikimedia.org/w/api.php?'+query)[0])
        for page in data['query']['pages']:
            if 'imageinfo' not in page:raise RuntimeError('Missing Commons file: '+page['title'])
            info=page['imageinfo'][0];ext=info['extmetadata']
            license_name=plain(ext.get('LicenseShortName',{}).get('value',''))
            if license_name.lower()!='public domain':raise RuntimeError('Unexpected license: '+page['title']+' '+license_name)
            metadata[page['title'].removeprefix('File:').replace(' ','_')]={
                'sourcePage':info['descriptionurl'], 'originalUrl':info['url'],
                'downloadUrl':info.get('thumburl',info['url']),
                'artist':plain(ext.get('Artist',{}).get('value','Pamela Colman Smith')),
                'license':license_name,'licenseUrl':ext.get('LicenseUrl',{}).get('value','https://creativecommons.org/publicdomain/mark/1.0/'),
                'originalSha1':info['sha1'],'width':info.get('thumbwidth',info['width']),'height':info.get('thumbheight',info['height']),
            }
        print(f'License metadata verified: {min(offset+26,len(ITEMS))}/{len(ITEMS)}',flush=True)
    def download(item):
        id,file=item;info=metadata[file];path=OUT/(id+'.jpg')
        url=info['downloadUrl']
        if urllib.parse.urlparse(url).hostname not in {'upload.wikimedia.org','thumb.wikimedia.org'}:raise RuntimeError('Unexpected asset host')
        if path.exists() and path.stat().st_size>1000:
            blob=path.read_bytes()
        else:
            blob,mime=request(url)
            if not mime.startswith('image/jpeg') or not blob.startswith(b'\xff\xd8'):raise RuntimeError('Invalid JPEG: '+id)
            path.write_bytes(blob)
        return {'id':id,'file':id+'.jpg','commonsFile':file,**info,'sha256':hashlib.sha256(blob).hexdigest(),'bytes':len(blob)}
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(download,ITEMS):
            results.append(result)
            print(f'Downloaded {len(results):02d}/78: {result["id"]}',flush=True)
    manifest={'name':'经典韦特 · Rider-Waite-Smith','checkedAt':'2026-10-29','source':'Wikimedia Commons','artist':'Pamela Colman Smith, under the direction of A. E. Waite','license':'Public domain (per individual Commons file metadata)','imagesUnmodified':True,'cards':results}
    (OUT/'sources.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print('Verified and bundled all 78 classic cards. Total bytes:',sum(r['bytes'] for r in results),flush=True)

if __name__=='__main__':main()
