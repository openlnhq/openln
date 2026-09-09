#!/usr/bin/env python3
"""Install the pinned Cards frontend as part of ship dev/promote. No API/DB changes."""
from pathlib import Path
import hashlib,json,os,shutil,sys,tarfile,tempfile,subprocess
root=Path(__file__).resolve().parent.parent
mode=sys.argv[1] if len(sys.argv)>1 else ''
if mode not in ('dev','prod','local'):raise SystemExit('Use dev|prod|local')
manifest=json.loads((root/'artifacts/cards-shop-release.json').read_text())
archive=root/'artifacts'/manifest['archive']
if hashlib.sha256(archive.read_bytes()).hexdigest()!=manifest['sha256']:raise SystemExit('Cards artifact checksum mismatch')
base=root/'artifacts/cards-shop';base.mkdir(exist_ok=True)
release=base/manifest['sha256'][:16]
if not release.exists():
 stage=Path(tempfile.mkdtemp(prefix='unpack-',dir=base))
 try:
  with tarfile.open(archive,'r:gz') as tar:
   for member in tar.getmembers():
    if member.issym() or member.islnk() or not (stage/member.name).resolve().is_relative_to(stage.resolve()):raise SystemExit('Unsafe archive path')
   tar.extractall(stage)
  if not (stage/'public/index.html').is_file() or not (stage/'preview/index.html').is_file():raise SystemExit('Missing Cards build')
  stage.chmod(0o755) # Caddy must traverse the versioned static root.
  stage.rename(release)
 except BaseException:shutil.rmtree(stage,ignore_errors=True);raise
link=base/'.current-next'
link.unlink(missing_ok=True);link.symlink_to(release.name);os.replace(link,base/'current')
if mode=='prod':
 # The live shop backend and database stay untouched. Its static root switches
 # atomically to a verified, versioned build; original dist remains recoverable.
 repo=Path('/opt/maekob')
 if subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=repo,text=True).strip():raise SystemExit('Cards source DRIFT; refusing deploy')
 subprocess.run(['git','fetch','origin','prod-live'],cwd=repo,check=True)
 subprocess.run(['git','cat-file','-e',manifest['sourceCommit']+'^{commit}'],cwd=repo,check=True)
 dest=repo/'artifacts/maekob-shop/dist/public'
 if not dest.is_symlink():
  backup=dest.with_name('public-before-shared-ship')
  if backup.exists():raise SystemExit('Original Cards backup already exists; inspect before replacing')
  dest.rename(backup)
 new=dest.with_name('.public-next');new.unlink(missing_ok=True);new.symlink_to(release/'public');os.replace(new,dest)
 # Pin the source to the exact commit that produced the build (never a new
 # backend bundle, restart, env copy, or DB migration).
 subprocess.run(['git','checkout','--detach',manifest['sourceCommit']],cwd=repo,check=True)
 (repo/'.cards-ui-deployed').write_text(manifest['sourceCommit']+' '+manifest['sha256']+'\n')
print(json.dumps({'cardsSource':manifest['sourceCommit'],'artifactSha256':manifest['sha256'],'mode':mode,'previewRoot':str(release/'preview'),'liveStaticUpdated':mode=='prod'}))
