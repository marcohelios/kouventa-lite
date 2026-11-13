package routes

import (
	"time"
	"fmt"

	"storefront-go/auth"
	"storefront-go/models"

	"github.com/google/uuid"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

func RegisterAuthRoutes(app *fiber.App, db *gorm.DB) {
	app.Post("/auth/register", func(c *fiber.Ctx) error {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := c.BodyParser(&body); err != nil || len(body.Password) < 8 {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid email or password too short"})
		}

		var existing models.User
		if db.Where("email = ?", body.Email).First(&existing).Error == nil {
			return c.Status(409).JSON(fiber.Map{"error": "Email already registered"})
		}

		hash, err := auth.HashPassword(body.Password)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to hash password"})
		}

		user := models.User{
			ID:           uuid.NewString(),
			Email:        body.Email,
			PasswordHash: hash,
			Role:         models.RoleNormal,
		}
		if err := db.Create(&user).Error; err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to create user"})
		}

		token, _ := auth.SignToken(user.ID, user.Email, string(user.Role))
		c.Cookie(&fiber.Cookie{Name: "token", Value: token, HTTPOnly: true, Path: "/", SameSite: "Lax"})
		return c.JSON(fiber.Map{"user": fiber.Map{"id": user.ID, "email": user.Email, "role": user.Role}})
	})

app.Post("/auth/login", func(c *fiber.Ctx) error {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request payload"})
	}

	// 👇 temporary debug lines
	fmt.Println("DEBUG email received:", body.Email)
	fmt.Println("DEBUG password length received:", len(body.Password))

	var user models.User
	if db.Where("email = ?", body.Email).First(&user).Error != nil {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid email or password"})
	}

	// 👇 temporary debug lines
	fmt.Println("DEBUG stored hash:", user.PasswordHash)

	match, _ := auth.VerifyPassword(user.PasswordHash, body.Password)
	fmt.Println("DEBUG match result:", match)   // 👈 add this too
	if !match {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid email or password"})
	}

		token, _ := auth.SignToken(user.ID, user.Email, string(user.Role))
		c.Cookie(&fiber.Cookie{Name: "token", Value: token, HTTPOnly: true, Path: "/", SameSite: "Lax"})
		return c.JSON(fiber.Map{"user": fiber.Map{"id": user.ID, "email": user.Email, "role": user.Role}})
	})

	app.Post("/auth/logout", func(c *fiber.Ctx) error {
		c.Cookie(&fiber.Cookie{Name: "token", Value: "", Path: "/", Expires: time.Now().Add(-time.Hour)})
		return c.JSON(fiber.Map{"success": true})
	})

	app.Get("/auth/me", auth.AuthMiddleware, func(c *fiber.Ctx) error {
		claims := c.Locals("user").(*auth.Claims)
		return c.JSON(fiber.Map{"user": claims})
	})
}