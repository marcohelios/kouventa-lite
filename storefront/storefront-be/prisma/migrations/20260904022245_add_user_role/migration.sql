-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('NORMAL', 'PREMIUM');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'NORMAL';
