#!/bin/bash
set -e

SUBS="restaurantowners,KitchenConfidential,Restaurant_Managers,smallbusiness"
MAX=50
OUTDIR="./research-output"
mkdir -p "$OUTDIR"

topics=(
  "doordash ubereats restaurant owner"
  "restaurant competition from chains"
  "restaurant marketing getting customers"
  "restaurant owner burnout work life balance"
)

labels=(
  "3-delivery-apps"
  "4-chain-competition"
  "5-customer-acquisition"
  "6-burnout"
)

echo "======================================"
echo "  Reddit Research: Competitive Challenges"
echo "  $(date)"
echo "======================================"
echo ""

for i in "${!topics[@]}"; do
  topic="${topics[$i]}"
  label="${labels[$i]}"
  outfile="$OUTDIR/$label.txt"

  echo ">>> [$((i+1))/4] Searching: \"$topic\""
  echo "    Output: $outfile"
  echo ""

  npx tsx reddit-synopsis.ts \
    --topic "$topic" \
    --subreddit "$SUBS" \
    --max-items "$MAX" \
    2>&1 | tee "$outfile"

  echo ""
  echo "--- Saved to $outfile ---"
  echo ""
done

echo "======================================"
echo "  All 4 searches complete!"
echo "  Results saved to: $OUTDIR/"
echo "======================================"
