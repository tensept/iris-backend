import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  decimal,
  boolean,
  json,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* Users */
export const users = pgTable("users", {
  userID: serial("userID").primaryKey(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }),

  role: varchar("role", { length: 20 }).default("CUSTOMER"),

  // 🔑 แยก token แต่ละประเภท
  verifyToken: varchar("verify_token", { length: 255 }), // สำหรับ email verification
  resetToken: varchar("reset_token", { length: 255 }),   // สำหรับ reset password
  refreshToken: varchar("refresh_token", { length: 255 }), // สำหรับ session refresh
  emailVerifiedAt: timestamp("email_verified_at", { mode: "date" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});


/* Categories */
export const categories = pgTable("categories", {
  cId: serial("c_id").primaryKey(),
  pcname: varchar("pcname", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Products */
export const products = pgTable("products", {
  pId: serial("p_id").primaryKey(),
  pname: varchar("pname", { length: 255 }),
  description: text("description"),
  basePrice: decimal("base_price", { precision: 10, scale: 2 }),
  pcId: integer("pc_id").references(() => categories.cId),
  primaryImageUrl: varchar("primary_image_url", { length: 500 }),
  images: json("images"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Product Variants */
export const productVariants = pgTable("product_variants", {
  id: serial("id").primaryKey(),
  pId: integer("p_id").references(() => products.pId),
  sku: varchar("sku", { length: 100 }).notNull().unique(),
  shadeName: varchar("shade_name", { length: 100 }),
  shadeCode: varchar("shade_code", { length: 50 }),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  stockQty: integer("stock_qty").default(0).notNull(),
  isActive: boolean("is_active").default(true),
  imageUrl: varchar("image_url", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Carts */
export const carts = pgTable("carts", {
  id: serial("id").primaryKey(),
  userID: integer("userID").references(() => users.userID),
  sessionId: varchar("session_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Cart Items */
export const cartItems = pgTable("cart_items", {
  id: serial("id").primaryKey(),
  cartId: integer("cart_id").references(() => carts.id),
  variantId: integer("variant_id").references(() => productVariants.id),
  qty: integer("qty").default(1).notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  lineTotal: decimal("line_total", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Orders */
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  userID: integer("userID").references(() => users.userID),
  status: varchar("status", { length: 50 }),
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).default("0").notNull(),
  shippingFee: decimal("shipping_fee", { precision: 10, scale: 2 }).default("0").notNull(),
  discountTotal: decimal("discount_total", { precision: 10, scale: 2 }).default("0").notNull(),
  grandTotal: decimal("grand_total", { precision: 10, scale: 2 }).default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/* Order Items */
export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => orders.id),
  productId: integer("product_id").references(() => products.pId),
  variantId: integer("variant_id").references(() => productVariants.id),
  name: varchar("name", { length: 255 }),
  shadeName: varchar("shade_name", { length: 100 }),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  qty: integer("qty").notNull(),
  lineTotal: decimal("line_total", { precision: 10, scale: 2 }).notNull(),
});

/* Invoices */
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  orderID: integer("orderID").references(() => orders.id),
  number: varchar("number", { length: 100 }).unique(),
  issuedAt: timestamp("issued_at"),
  status: varchar("status", { length: 50 }), // issued/void
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
