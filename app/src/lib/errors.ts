export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}
export const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "يجب تسجيل الدخول");
export const forbidden = (why = "FORBIDDEN") => new AppError(403, why, "ليست لديك صلاحية لهذه العملية");
export const badRequest = (code: string, msg?: string) => new AppError(400, code, msg);
export const conflict = (code: string, msg?: string) => new AppError(409, code, msg);
export const notFound = () => new AppError(404, "NOT_FOUND", "غير موجود");
