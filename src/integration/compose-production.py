"""Export production dependencies without merges or edits to source worktrees."""
import argparse
import io
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--database-ref', default='78da06f016ff87c3a7ec0d539890672640125743')
p.add_argument('--identity-ref', default='710cb91bb5061b3817217263e8ee595944eacca0')
p.add_argument('--output', type=pathlib.Path)
a = p.parse_args()
dest = a.output or pathlib.Path(tempfile.mkdtemp(prefix='skill-production-'))
if a.output:
    dest.mkdir(parents=True, exist_ok=False)
revisions = {}
for module, ref in {'web':'WItaZhang/skill-web-v2','broadcast':'WItaZhang/skill-broadcast-v2','identity':a.identity_ref,'persistence':a.database_ref}.items():
    revisions[module] = subprocess.check_output(['git','rev-parse',ref],cwd=root,text=True).strip()
    paths = [f'src/modules/{module}']
    if module == 'persistence':
        paths.append('src/contracts/production.ts')
    data = subprocess.check_output(['git','archive',ref,*paths],cwd=root)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member: ' + member.name)
        archive.extractall(dest)
for folder in ['integration','modules/product']:
    shutil.copytree(root/'src'/folder,dest/'src'/folder,ignore=shutil.ignore_patterns('node_modules','dist','test-results','__pycache__'))
for name in ['index.ts','README.md']:
    shutil.copy2(root/'src/contracts'/name,dest/'src/contracts'/name)
shutil.copy2(root/'src/package.json',dest/'src/package.json')
(dest/'src/node_modules').symlink_to('modules/product/node_modules',target_is_directory=True)
revisions['product'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
revisions['productDirty'] = bool(subprocess.check_output(['git','status','--porcelain','--','src/modules/product','src/integration'],cwd=root,text=True).strip())
(dest/'source-revisions.json').write_text(json.dumps(revisions,indent=2)+'\n')
print(dest)
print(json.dumps(revisions,indent=2))
