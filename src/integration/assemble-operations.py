"""Read-only export of this worktree plus COMMITTED owners into a new temporary directory."""
import argparse,io,json,pathlib,shutil,subprocess,tarfile,tempfile
root=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser()
p.add_argument('--execution-ref',required=True)
p.add_argument('--collaboration-ref',required=True)
a=p.parse_args()
dest=pathlib.Path(tempfile.mkdtemp(prefix='production-operations-combined-'))
ignore=shutil.ignore_patterns('.git','node_modules','dist','test-results','__pycache__','.env','.env.local','secrets','backups')
shutil.copytree(root,dest,dirs_exist_ok=True,ignore=ignore)
refs={}
for name,ref,paths in [('execution',a.execution_ref,['src/modules/execution','src/modules/persistence','src/contracts/execution.ts']),('collaboration',a.collaboration_ref,['src/modules/product','src/modules/identity','src/modules/broadcast','src/modules/collaboration'])]:
 sha=subprocess.check_output(['git','rev-parse',ref],cwd=root,text=True).strip();refs[name]=sha
 for path in paths:
  target=dest/path
  if target.is_dir():shutil.rmtree(target)
  elif target.exists():target.unlink()
 data=subprocess.check_output(['git','archive',sha,*paths],cwd=root)
 with tarfile.open(fileobj=io.BytesIO(data)) as archive:
  for member in archive.getmembers():
   path=pathlib.PurePosixPath(member.name)
   if path.is_absolute() or '..' in path.parts or not(member.isfile()or member.isdir()):raise ValueError('Unsafe archive member')
  archive.extractall(dest)
refs['operations']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
refs['operationsDirty']=bool(subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip())
(dest/'source-revisions.json').write_text(json.dumps(refs,indent=2)+'\n')
print(dest)
print(json.dumps(refs,indent=2))
