//go:build savedchat_standalone

package routes

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"testing"
)

// File-list runner for chat_sync.go + chat_sync_generation_test.go, without
// compiling the unrelated application and backend routes in the full suite.
func TestSavedChatRoutes(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Saved chat HTTP routes")
}
