# Panorama quality suite

Stitch quality cannot be regression-tested from a real phone, so this suite
manufactures captures whose correct answer is already known.

`harness.py` renders the 24 guided stills out of an existing equirectangular
image, applies controllable yaw/pitch/roll errors, writes the matching W3C
device-orientation samples and optional exposure brackets, runs the real
`scripts/panorama-stitcher.py`, and scores the panorama that comes back
against the image everything was rendered from.

Because the harness inverts a camera pose into the alpha/beta/gamma a phone
would report, and the stitcher independently converts those angles back into a
camera pose, the motion-data cases check both halves of that conversion
end to end. A sign error anywhere in the chain makes the score worse, not
better.

## Running it

Requires the panorama dependencies (`npm run setup:panorama`).

```bash
cd tests/panorama-quality
python run_suite.py           # full matrix
python run_suite.py --quick   # skip the slow full-resolution case
```

Results are written to `RESULTS.md` (committed) plus `output/results.json` and
one panorama JPEG per case in `output/` (ignored by git) so the outcome can be
inspected visually, not only as numbers. The suite exits non-zero when a case
misses its budget.

To run a single case:

```bash
python harness.py --source ../../public/images/tours/flagship/arrival-2048.webp \
  --perturb --imu --label my-case --keep output
```

## Reading the score

`rmse` is the reconstruction error against the source panorama after searching
every circular shift, since the yaw origin of a stitch is arbitrary. Lower is
better. Zone scores split that by latitude, so the `upper` zone is where
cross-band misalignment shows up first.

`clippedHighlights` is the share of the source's bright regions that saturated
to flat white in the result, which is what exposure bracketing exists to
prevent. It deliberately does not compare brightness directly: exposure fusion
tone-maps the whole image, so a brightness comparison would punish a fused
result that actually kept more detail.

Several cases are paired with a control run that withholds the input a feature
depends on. Those checks assert the feature run beats its control, so they
prove the feature works rather than only asserting an absolute number.

The bare-wall pair works the same way: the control stitches a room whose wall
band has been washed out to near-featureless paint using SIFT only, which is
expected to degrade or be rejected, and the learned case must stitch the same
room cleanly through the SuperPoint+LightGlue rescue matcher. Both cases are
skipped when the matcher model is not installed
(`npm run setup:panorama` downloads it).
