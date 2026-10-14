export function splitAmount(amountMinor: number, commissionBasisPoints = 1500) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('amount must be a positive safe integer');
  if (!Number.isInteger(commissionBasisPoints) || commissionBasisPoints < 0 || commissionBasisPoints > 10_000) {
    throw new Error('invalid commission rate');
  }
  // Split before multiplication so the intermediate value stays inside
  // Number.MAX_SAFE_INTEGER even when the accepted amount is near that limit.
  const whole = Math.floor(amountMinor / 10_000) * commissionBasisPoints;
  const remainder = Math.floor((amountMinor % 10_000) * commissionBasisPoints / 10_000);
  const commissionMinor = whole + remainder;
  return { commissionMinor, professionalMinor: amountMinor - commissionMinor };
}

// Reverse the difference between cumulative splits so arbitrarily fragmented
// refunds reverse exactly the original commission, including rounding pennies.
export function splitRefund(alreadyRefunded: number, refundAmount: number) {
  if (!Number.isSafeInteger(alreadyRefunded) || alreadyRefunded < 0
      || !Number.isSafeInteger(refundAmount) || refundAmount <= 0
      || !Number.isSafeInteger(alreadyRefunded + refundAmount)) throw new Error('invalid refund');
  const before = alreadyRefunded ? splitAmount(alreadyRefunded).commissionMinor : 0;
  const commissionMinor = splitAmount(alreadyRefunded + refundAmount).commissionMinor - before;
  return { commissionMinor, professionalMinor: refundAmount - commissionMinor };
}
