"""Build a reviewable release directory without merging or changing module worktrees."""
import io
import json
import pathlib
import shutil
import subprocess
import tarfile

root = pathlib.Path(__file__).resolve().parents[2]
dest = root / 'src/.release'
if dest.exists():
    raise SystemExit('src/.release already exists; move it aside before composing another release.')
dest.mkdir()
revisions = {}
for module, branch in {
    'service': 'WItaZhang/skill-service-v2',
    'runtime': 'WItaZhang/skill-runtime',
    'broadcast': 'WItaZhang/skill-broadcast-v2',
    'web': 'WItaZhang/skill-web-v2',
}.items():
    revisions[module] = subprocess.check_output(['git', 'rev-parse', branch], cwd=root, text=True).strip()
    archive = subprocess.check_output(['git', 'archive', branch, f'src/modules/{module}'], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        for member in bundle.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe archive member: ' + member.name)
        bundle.extractall(dest)
for folder in ('contracts', 'acceptance', 'integration'):
    shutil.copytree(root / 'src' / folder, dest / 'src' / folder, ignore=shutil.ignore_patterns('__pycache__'))
shutil.copy2(root / 'src/package.json', dest / 'src/package.json')
# Only the assembled entry point changes; original modules and their history stay intact.
(dest / 'src/modules/web/main.tsx').write_text('import "../../integration/browser.tsx";\n')
(dest / 'src/node_modules').symlink_to('modules/web/node_modules', target_is_directory=True)
shutil.copy2(root / 'src/integration/Dockerfile', dest / 'Dockerfile')
(dest / '.dockerignore').write_text('**/node_modules\n**/dist\n**/*.sqlite*\n.git\n')
(dest / 'source-revisions.json').write_text(json.dumps(revisions, indent=2) + '\n')
print(dest)
print(json.dumps(revisions, indent=2))
