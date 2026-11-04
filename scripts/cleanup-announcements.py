"""Remove announcements 30 Warsaw calendar days after expiry; standard library only."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo

WARSAW = ZoneInfo('Europe/Warsaw')
UTC = timezone.utc
ISO = re.compile(r'\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?\Z')
LOG = logging.getLogger(__name__)


def warsaw_candidates(local):
    """Return actual instants for a wall time, rejecting the spring DST gap."""
    result = []
    for fold in (0, 1):
        instant = local.replace(tzinfo=WARSAW, fold=fold).astimezone(UTC)
        if instant.astimezone(WARSAW).replace(tzinfo=None) == local:
            result.append(instant)
    return result


def expiry_instant(value):
    if not isinstance(value, str) or not ISO.fullmatch(value):
        raise ValueError('expiresAt must be an ISO date or timestamp')
    offset = re.search(r'[+-](\d{2}):(\d{2})$', value)
    if offset and (int(offset[1]) > 23 or int(offset[2]) > 59):
        raise ValueError('expiresAt has an invalid timezone offset')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.year < 100:
        raise ValueError('expiresAt year must be at least 0100')
    if len(value) == 10:
        parsed += timedelta(days=1)  # A date is valid through the end of that day.
    if parsed.tzinfo is not None:
        return parsed.astimezone(UTC)
    candidates = warsaw_candidates(parsed)
    if not candidates:
        raise ValueError('expiresAt is a nonexistent Warsaw time during DST change')
    return min(candidates)  # Same interpretation as the browser during autumn overlap.


def deletion_instant(value):
    expired = expiry_instant(value).astimezone(WARSAW)
    target = expired.replace(tzinfo=None) + timedelta(days=30)
    candidates = warsaw_candidates(target)
    if candidates:
        return max(candidates)  # Ambiguous retention boundary: never delete early.
    # If the retention boundary lands in the spring gap, move forward, not backward.
    return max(target.replace(tzinfo=WARSAW, fold=fold).astimezone(UTC) for fold in (0, 1))


def filter_announcements(items, now):
    if not isinstance(items, list):
        raise ValueError('announcements.json must contain a JSON array')
    if now.tzinfo is None:
        raise ValueError('cleanup clock must include a timezone')
    kept = []
    removed = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            LOG.warning('Keeping record %d: expected a JSON object', index)
            kept.append(item)
            continue
        if item.get('expiresAt') is None:
            kept.append(item)
            continue
        try:
            if not isinstance(item.get('id'), str) or not item['id']:
                raise ValueError('missing or invalid announcement id')
            deadline = deletion_instant(item['expiresAt'])
        except (ValueError, TypeError, OverflowError) as error:
            LOG.warning('Keeping record %d (id=%r): %s', index, item.get('id'), error)
            kept.append(item)
            continue
        if now.astimezone(UTC) >= deadline:
            removed.append(item['id'])
        else:
            kept.append(item)
    return kept, removed


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + repr(key))
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError('Non-JSON numeric constant: ' + value)


def cleanup_file(path, now):
    original = path.read_text(encoding='utf-8')
    data = json.loads(original, object_pairs_hook=unique_keys, parse_constant=reject_constant)
    kept, removed = filter_announcements(data, now)
    if not removed:
        LOG.info('Nothing to remove; announcements.json is unchanged')
        return []
    # Serialize before touching the original. Replace atomically in the same directory.
    output = json.dumps(kept, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.announcements-', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(path.stat().st_mode & 0o777)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    LOG.info('Removed %d expired record(s): %r', len(removed), removed)
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, default=Path(__file__).resolve().parents[1] / 'announcements.json')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    try:
        cleanup_file(args.file, datetime.now(UTC))
    except (OSError, ValueError, TypeError, OverflowError) as error:
        LOG.error('Cleanup aborted; no publication: %s', error)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
