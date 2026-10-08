#!/usr/bin/env bash
# Does the DLD brokers/transactions endpoint accept a payload without a captcha?
set -u
U='https://gateway.dubailand.gov.ae/brokers/transactions'
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'

t() {
  local label="$1" body="$2" code
  code=$(curl -s --max-time 25 -X POST "$U" \
    -H 'Content-Type: application/json; charset=utf-8' \
    -H 'Origin: https://dubailand.gov.ae' -H 'Referer: https://dubailand.gov.ae/' \
    -A "$UA" -d "$body" -o /tmp/b.json -w '%{http_code}')
  printf '%-30s HTTP %-4s %s\n' "$label" "$code" "$(head -c 200 /tmp/b.json | tr -d '\n')"
}

t "empty"      '{}'
t "paging"     '{"P_TAKE":"5","P_SKIP":"0"}'
t "paging+sort" '{"P_TAKE":"5","P_SKIP":"0","P_SORT":"REGISTRATION_DATE_DESC"}'
t "dates"      '{"P_FROM_DATE":"09/01/2026","P_TO_DATE":"10/10/2026","P_TAKE":"5","P_SKIP":"0"}'
t "trxNo"      '{"P_TRANSACTION_NUMBER":"1"}'
