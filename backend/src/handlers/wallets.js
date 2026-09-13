const { parseWalletListQuery } = require("../utils/validation");

function handleListWallets({ listTaintedWallets, logger } = {}) {
  return async (req, res) => {
    try {
      const params = parseWalletListQuery(req.query || {});
      const result = await listTaintedWallets(params);
      res.json(result);
    } catch (error) {
      if (error.code === "INVALID_QUERY") {
        return res.status(400).json({
          error: "Invalid query",
          message: error.message,
        });
      }

      logger.error("Error listing wallets", { error: error.message });
      res.status(500).json({
        error: "Failed to list tainted wallets",
        message:
          "The server encountered an error while processing your request. Please try again.",
      });
    }
  };
}

module.exports = {
  handleListWallets,
};
