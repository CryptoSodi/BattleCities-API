import os
import pathlib
import sys
import tarfile

archive, target, commit = sys.argv[1:]
destination = pathlib.Path(target).resolve()
if destination.parent != pathlib.Path('/opt/battlecities-api/releases').resolve():
    raise RuntimeError('Unexpected release destination')
with tarfile.open(archive, 'r:') as source:
    if source.pax_headers.get('comment') != commit:
        raise RuntimeError('Git archive commit does not match the deployment request')
    members = source.getmembers()
    if len(members) > 20000 or sum(member.size for member in members) > 100 * 1024 * 1024:
        raise RuntimeError('Release archive exceeds extraction limits')
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
            raise RuntimeError('Unsafe archive entry')
        output = destination.joinpath(*name.parts)
        if not output.is_relative_to(destination):
            raise RuntimeError('Unsafe archive destination')
        if member.isdir():
            output.mkdir(parents=True, exist_ok=True)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as handle, source.extractfile(member) as content:
                while chunk := content.read(1024 * 1024):
                    handle.write(chunk)
            os.chmod(output, 0o755 if member.mode & 0o111 else 0o644)
