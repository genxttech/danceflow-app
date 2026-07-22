import "server-only";

export type AccountingEntryClass =
  | "revenue"
  | "refund"
  | "fee"
  | "expense"
  | "asset"
  | "liability"
  | "equity"
  | "adjustment";

export type AccountingStatementSection =
  | "income"
  | "contra_income"
  | "cost_of_sales"
  | "expense"
  | "asset"
  | "liability"
  | "equity"
  | "clearing";

export type AccountingDirection = "debit" | "credit";

export type AccountingCategoryDefinition = {
  key: string;
  label: string;
  entryClass: AccountingEntryClass;
  statementSection: AccountingStatementSection;
  normalDirection: AccountingDirection;
  allowedExternalAccountTypes: readonly string[];
  blocksAutoPostWhenUnmapped: boolean;
};

export const ACCOUNTING_CATEGORIES = [
  { key: "private_lesson_revenue", label: "Private Lesson Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "group_class_revenue", label: "Group Class Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "package_revenue", label: "Package Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "membership_revenue", label: "Membership Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "event_ticket_revenue", label: "Event Ticket Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "retail_revenue", label: "Retail Product Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "digital_content_revenue", label: "Digital Content Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "coach_private_lesson_revenue", label: "Coach Private Lesson Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "floor_rental_revenue", label: "Floor Rental Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "practice_party_revenue", label: "Practice Party Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "other_revenue", label: "Other Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },
  { key: "unclassified_revenue", label: "Unclassified Revenue", entryClass: "revenue", statementSection: "income", normalDirection: "credit", allowedExternalAccountTypes: ["INCOME", "REVENUE"], blocksAutoPostWhenUnmapped: true },

  { key: "client_payment_refund", label: "Client Payment Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "package_refund", label: "Package Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "membership_refund", label: "Membership Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "floor_rental_refund", label: "Floor Rental Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "event_ticket_refund", label: "Event Ticket Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "retail_refund", label: "Retail Product Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "digital_content_refund", label: "Digital Content Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "other_refund", label: "Other Refund", entryClass: "refund", statementSection: "contra_income", normalDirection: "debit", allowedExternalAccountTypes: ["INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },

  { key: "stripe_processing_fee", label: "Stripe Processing Fee", entryClass: "fee", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "danceflow_platform_fee", label: "DanceFlow Platform Fee", entryClass: "fee", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "organizer_platform_fee", label: "Organizer Platform Fee", entryClass: "fee", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },

  { key: "retail_cogs", label: "Retail Cost of Goods Sold", entryClass: "expense", statementSection: "cost_of_sales", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE", "COST_OF_GOODS_SOLD"], blocksAutoPostWhenUnmapped: true },
  { key: "floor_fee_expense", label: "Floor Fee Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "rent_expense", label: "Rent Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "instructor_pay_expense", label: "Instructor Pay Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "marketing_expense", label: "Marketing Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "software_expense", label: "Software Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "supplies_expense", label: "Supplies Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "costumes_retail_inventory_expense", label: "Costumes / Retail Inventory Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE", "ASSET"], blocksAutoPostWhenUnmapped: true },
  { key: "event_expense", label: "Event Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE", "COST_OF_GOODS_SOLD"], blocksAutoPostWhenUnmapped: true },
  { key: "event_labor_expense", label: "Event Labor Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE", "COST_OF_GOODS_SOLD"], blocksAutoPostWhenUnmapped: true },
  { key: "travel_expense", label: "Travel Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "meals_expense", label: "Meals Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "utilities_expense", label: "Utilities Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "insurance_expense", label: "Insurance Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "professional_services_expense", label: "Professional Services Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "other_expense", label: "Other Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },

  { key: "contract_labor_expense", label: "Contract Labor Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "employee_wage_expense", label: "Employee Wage Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "payroll_tax_expense", label: "Payroll Tax Expense", entryClass: "expense", statementSection: "expense", normalDirection: "debit", allowedExternalAccountTypes: ["EXPENSE"], blocksAutoPostWhenUnmapped: true },
  { key: "accrued_compensation_liability", label: "Accrued Compensation Liability", entryClass: "liability", statementSection: "liability", normalDirection: "credit", allowedExternalAccountTypes: ["LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "payroll_tax_liability", label: "Payroll Tax Liability", entryClass: "liability", statementSection: "liability", normalDirection: "credit", allowedExternalAccountTypes: ["LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "employee_withholding_liability", label: "Employee Withholding Liability", entryClass: "liability", statementSection: "liability", normalDirection: "credit", allowedExternalAccountTypes: ["LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "reimbursement_payable", label: "Reimbursement Payable", entryClass: "liability", statementSection: "liability", normalDirection: "credit", allowedExternalAccountTypes: ["LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "payroll_cash_clearing", label: "Payroll Cash Clearing", entryClass: "asset", statementSection: "clearing", normalDirection: "credit", allowedExternalAccountTypes: ["ASSET", "BANK"], blocksAutoPostWhenUnmapped: true },

  { key: "account_credit", label: "Account Credit", entryClass: "liability", statementSection: "liability", normalDirection: "credit", allowedExternalAccountTypes: ["LIABILITY"], blocksAutoPostWhenUnmapped: true },
  { key: "manual_adjustment", label: "Manual Adjustment", entryClass: "adjustment", statementSection: "equity", normalDirection: "debit", allowedExternalAccountTypes: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "REVENUE", "EXPENSE"], blocksAutoPostWhenUnmapped: true },
] as const satisfies readonly AccountingCategoryDefinition[];

export type AccountingCategoryKey = (typeof ACCOUNTING_CATEGORIES)[number]["key"];

const CATEGORY_BY_KEY = new Map<string, AccountingCategoryDefinition>(
  ACCOUNTING_CATEGORIES.map((category) => [category.key, category]),
);

export function getAccountingCategory(
  key: string | null | undefined,
): AccountingCategoryDefinition | null {
  if (!key) return null;
  return CATEGORY_BY_KEY.get(key) ?? null;
}

export function accountingCategoryLabel(key: string | null | undefined) {
  return getAccountingCategory(key)?.label ?? humanizeAccountingCategory(key);
}

export function isSupportedAccountingCategory(
  key: string | null | undefined,
): key is AccountingCategoryKey {
  return Boolean(key && CATEGORY_BY_KEY.has(key));
}

export function blocksAccountingAutoPost(key: string | null | undefined) {
  const category = getAccountingCategory(key);
  return !category || category.blocksAutoPostWhenUnmapped;
}

export function isCategoryAccountTypeAllowed(
  categoryKey: string,
  accountType: string | null | undefined,
) {
  const category = getAccountingCategory(categoryKey);
  if (!category || !accountType) return false;
  const normalized = accountType.trim().toUpperCase();
  return category.allowedExternalAccountTypes.includes(normalized);
}

function humanizeAccountingCategory(key: string | null | undefined) {
  if (!key) return "Uncategorized";
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
