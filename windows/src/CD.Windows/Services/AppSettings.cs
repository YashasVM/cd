using System.IO;
using System.Text.Json;

namespace CD.Windows.Services;

public sealed class AppSettings
{
    public string? ClerkIssuer { get; }
    public string? ClerkClientId { get; }
    public string StoreUrl { get; }
    public bool ClerkConfigured => !string.IsNullOrWhiteSpace(ClerkIssuer) && !string.IsNullOrWhiteSpace(ClerkClientId);

    public AppSettings(string? clerkIssuer, string? clerkClientId, string? storeUrl = null)
    {
        ClerkIssuer = Clean(clerkIssuer);
        ClerkClientId = Clean(clerkClientId);
        StoreUrl = Clean(storeUrl) ?? "https://getcroc.com";
    }

    public static AppSettings Load(string? path = null)
    {
        string? issuer = null, clientId = null, storeUrl = null;
        var settingsPath = path ?? Path.Combine(AppContext.BaseDirectory, "appsettings.json");

        if (File.Exists(settingsPath))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
                var root = document.RootElement;
                issuer = Read(root, "ClerkIssuer");
                clientId = Read(root, "ClerkClientId");
                storeUrl = Read(root, "StoreUrl");

                if (root.TryGetProperty("Clerk", out var clerk) && clerk.ValueKind == JsonValueKind.Object)
                {
                    issuer ??= Read(clerk, "Issuer");
                    clientId ??= Read(clerk, "ClientId");
                }
            }
            catch (JsonException)
            {
                // Optional local configuration must not prevent the app from starting.
            }
            catch (IOException)
            {
                // The same applies when an installer or editor temporarily locks the file.
            }
        }

        return new AppSettings(
            Environment.GetEnvironmentVariable("CD_CLERK_ISSUER") ?? issuer,
            Environment.GetEnvironmentVariable("CD_CLERK_CLIENT_ID") ?? clientId,
            Environment.GetEnvironmentVariable("CD_STORE_URL") ?? storeUrl);
    }

    private static string? Read(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
