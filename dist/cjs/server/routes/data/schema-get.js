"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addRoutes = void 0;
const admin_only_1 = __importDefault(require("../../middleware/admin-only"));
const error_1 = require("../../shared/error");
const addRoutes = (env) => {
    env.router.get(`/schema/:dbName/*`, (0, admin_only_1.default)(env), async (req, res) => {
        const { dbName } = req.params;
        if (!env.hasDatabase(dbName)) {
            return (0, error_1.sendError)(res, {
                code: "not_found",
                message: `Database '${dbName}' not found`,
            });
        }
        // Get defined schema for a specifc path
        try {
            const path = req.params["0"];
            const schema = await env.db(dbName).schema.get(path);
            if (!schema) {
                return res.status(410).send("Not Found");
            }
            res.contentType("application/json").send({
                path: schema.path,
                schema: typeof schema.schema === "string" ? schema.schema : schema.text,
                text: schema.text,
            });
        }
        catch (err) {
            (0, error_1.sendError)(res, err);
        }
    });
};
exports.addRoutes = addRoutes;
exports.default = exports.addRoutes;
//# sourceMappingURL=schema-get.js.map