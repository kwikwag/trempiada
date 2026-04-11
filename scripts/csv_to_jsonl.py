import csv, json, sys, io, argparse, re, urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--encoding', default='utf-8')
parser.add_argument('--delimiter', default='|')
parser.add_argument('--filter', nargs='+')
args = parser.parse_args()

def parse_filter(f):
  kvs = {k: re.compile(v[0]) for k, v in urllib.parse.parse_qs(f).items()}
  def matcher(r):
    for k, v in kvs.items():
      inverse_condition = k.endswith('!')
      if inverse_condition:
        k = k[:-1]
      if (v.search(r[k]) is None) is not inverse_condition:
        return False
    return True
  return matcher

filters = [parse_filter(f) for f in args.filter] if args.filter is not None else None

with io.TextIOWrapper(sys.stdin.buffer, encoding=args.encoding, errors="ignore") as fp:
  for r in csv.DictReader(fp, delimiter=args.delimiter):
    if filters is not None and not any(f(r) for f in filters):
      continue
    json.dump(r, sys.stdout, separators=(',', ':'))
    print("")
