#!/usr/bin/env python3
"""Read-only peer export into a new temporary directory. Never merge or edit peers."""
import argparse
import io
import json
import pathlib
import shutil
import subprocess
import tempfile
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--execution', type=pathlib.Path, required=True)
parser.add_argument('--operations', type=pathlib.Path, required=True)
parser.add_argument('--execution-ref', default='HEAD')
parser.add_argument('--operations-ref', default='HEAD')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[3]
target = pathlib.Path(tempfile.mkdtemp(prefix='skill-collaboration-combined-'))
ignore = shutil.ignore_patterns('node_modules', 'dist', 'test-results', '.vite', '__pycache__', '*.sqlite*', '*.db*', '.env', '.env.*')
shutil.copytree(root / 'src', target / 'src', ignore=ignore)
for peer, ref, paths in [
    (args.execution, args.execution_ref, ['src/modules/execution', 'src/modules/persistence', 'src/contracts/execution.ts']),
    (args.operations, args.operations_ref, ['src/integration', 'src/modules/operations', 'src/deployment', 'src/package.json']),
]:
    for relative in paths:
        destination = target / relative
        if destination.is_dir(): shutil.rmtree(destination)
        elif destination.exists(): destination.unlink()
    archive = subprocess.check_output(['git', '-C', str(peer), 'archive', '--format=tar', ref, '--', *paths])
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        # Python 3.9 ships on some development Macs; validate data members without
        # relying on the newer tarfile filter keyword. No links/devices are needed.
        members = files.getmembers()
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe/non-data archive member: ' + member.name)
        files.extractall(target, members=members)
evidence = {}
for name, source, ref in [('collaboration', root, 'HEAD'), ('execution', args.execution, args.execution_ref), ('operations', args.operations, args.operations_ref)]:
    evidence[name] = {
        'path': str(source),
        'head': subprocess.check_output(['git', '-C', str(source), 'rev-parse', ref], text=True).strip(),
        'includesWorkingChanges': name == 'collaboration',
        'workingChanges': subprocess.check_output(['git', '-C', str(source), 'status', '--short'], text=True).strip() if name == 'collaboration' else '',
    }
(target / 'sources.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(target)
