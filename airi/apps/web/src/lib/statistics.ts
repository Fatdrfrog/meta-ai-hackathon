export function medianFromSortedValues(
  sortedValues: readonly number[]
): number | null {
  if (sortedValues.length === 0) return null;

  const midpoint = Math.floor(sortedValues.length / 2);
  const upperMiddle = sortedValues[midpoint];
  if (upperMiddle === undefined) return null;
  if (sortedValues.length % 2 === 1) return upperMiddle;

  const lowerMiddle = sortedValues[midpoint - 1];
  return lowerMiddle === undefined
    ? null
    : (lowerMiddle + upperMiddle) / 2;
}
