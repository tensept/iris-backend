// src/routes/admin/products.ts
import { Router } from "express";
import { dbClient } from "../../../db/client.ts";
import { products } from "../../../db/schema.ts";

// src/routes/admin/products.ts
const AdminProductRouter = Router();

AdminProductRouter.get("/", async (req, res) => {
  const allProducts = await dbClient.select().from(products);
  res.json(allProducts);
});

export default AdminProductRouter;
