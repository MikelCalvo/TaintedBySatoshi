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

module.exports = {
  normalizeTaintedDegree,
};
