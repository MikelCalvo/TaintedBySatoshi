function normalizeTaintedDegree(value) {
  const degree = Number.isInteger(value)
    ? value
    : value && Number.isInteger(value.degree)
      ? value.degree
      : null;

  if (degree === null || degree < 0) {
    throw new TypeError("Invalid tainted outpoint degree");
  }

  return degree;
}

function normalizeTaintedOutpoint(value) {
  return {
    degree: normalizeTaintedDegree(value),
    address:
      value && typeof value === "object" && typeof value.address === "string"
        ? value.address
        : null,
  };
}

module.exports = {
  normalizeTaintedDegree,
  normalizeTaintedOutpoint,
};
