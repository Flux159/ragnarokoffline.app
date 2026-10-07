"""Read an explicit diagnostic region without interpreting C++ syntax."""
import re


def source_region(source, name, path):
    """Return the verbatim region; missing or ambiguous markers are an error."""
    markers = {}
    for boundary in ('BEGIN', 'END'):
        pattern = rf'^[ \t]*// DIAGNOSTIC-{boundary}: {re.escape(name)}[ \t]*\r?$'
        markers[boundary] = list(re.finditer(pattern, source, re.MULTILINE))
    if len(markers['BEGIN']) != 1 or len(markers['END']) != 1:
        raise ValueError(f'{path}: expected exactly one BEGIN and END diagnostic marker for {name}')
    begin, end = markers['BEGIN'][0], markers['END'][0]
    if begin.end() >= end.start():
        raise ValueError(f'{path}: reversed diagnostic markers for {name}')
    return source[begin.end() + 1:end.start()]
