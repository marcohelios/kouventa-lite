package auth

import (
	"github.com/gofiber/fiber/v2"
)

func AuthMiddleware(c *fiber.Ctx) error {
	token := c.Cookies("token")
	if token == "" {
		return c.Status(401).JSON(fiber.Map{"error": "Unauthorized"})
	}
	claims, err := VerifyToken(token)  
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "Unauthorized"})
	}
	c.Locals("user", claims)
	return c.Next()
}

func RequireRole(role string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims := c.Locals("user").(*Claims)   
		if claims.Role != role {
			return c.Status(403).JSON(fiber.Map{"error": "Forbidden"})
		}
		return c.Next()
	}
}