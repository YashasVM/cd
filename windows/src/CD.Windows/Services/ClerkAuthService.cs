using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CD.Windows.Services;

public sealed record ClerkUser(string Id, string DisplayName, string Email, string? PictureUrl);

public sealed class ClerkAuthService
{
    private const string CallbackPath = "/callback";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private static readonly byte[] CredentialEntropy = Encoding.UTF8.GetBytes("CD.Windows.Clerk.RefreshToken.v1");
    private readonly AppSettings _settings;

    public ClerkAuthService(AppSettings settings) => _settings = settings ?? throw new ArgumentNullException(nameof(settings));

    public ClerkUser? CurrentUser { get; private set; }
    public bool IsConfigured => _settings.ClerkConfigured;

    public async Task<ClerkUser?> RestoreAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured)
        {
            CurrentUser = null;
            return null;
        }

        string? refreshToken;
        try
        {
            refreshToken = await ReadRefreshTokenAsync(cancellationToken);
        }
        catch (Exception exception) when (exception is CryptographicException or IOException or UnauthorizedAccessException)
        {
            ClearRefreshToken();
            CurrentUser = null;
            return null;
        }

        if (string.IsNullOrEmpty(refreshToken))
        {
            CurrentUser = null;
            return null;
        }

        try
        {
            using var timeout = Timeout(cancellationToken, TimeSpan.FromSeconds(30));
            var metadata = await GetMetadataAsync(timeout.Token);
            var tokens = await RequestTokensAsync(metadata.TokenEndpoint, new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
                ["client_id"] = _settings.ClerkClientId!
            }, timeout.Token);
            var user = await GetUserAsync(tokens.AccessToken, timeout.Token);
            if (!string.IsNullOrEmpty(tokens.RefreshToken))
                await WriteRefreshTokenAsync(tokens.RefreshToken, timeout.Token);
            CurrentUser = user;
            return user;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            CurrentUser = null;
            return null;
        }
        catch (Exception exception) when (exception is HttpRequestException or InvalidOperationException or JsonException or FormatException or IOException or UnauthorizedAccessException or CryptographicException)
        {
            ClearRefreshToken();
            CurrentUser = null;
            return null;
        }
    }

    public async Task<ClerkUser> SignInAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("Clerk sign-in has not been configured.");

        using var timeout = Timeout(cancellationToken, TimeSpan.FromMinutes(5));
        var metadata = await GetMetadataAsync(timeout.Token);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(1);

        var callback = new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}{CallbackPath}");
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var state = RandomNumberGenerator.GetBytes(32);
        var stateText = Base64Url(state);
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var authorizationUrl = AddQuery(metadata.AuthorizationEndpoint, new Dictionary<string, string>
        {
            ["response_type"] = "code",
            ["client_id"] = _settings.ClerkClientId!,
            ["redirect_uri"] = callback.AbsoluteUri,
            ["scope"] = "openid profile email offline_access",
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["state"] = stateText
        });

        try
        {
            Process.Start(new ProcessStartInfo(authorizationUrl) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException("Unable to open the system browser for sign-in.", exception);
        }

        var response = await ReadCallbackAsync(listener, timeout.Token);
        if (!CryptographicOperations.FixedTimeEquals(state, FromBase64Url(response.State)))
            throw new InvalidOperationException("The OAuth callback state did not match the sign-in request.");
        if (!string.IsNullOrEmpty(response.Error))
            throw new InvalidOperationException($"Clerk sign-in was cancelled or denied ({response.Error}).");
        if (string.IsNullOrEmpty(response.Code))
            throw new InvalidOperationException("The OAuth callback did not include an authorization code.");

        var tokens = await RequestTokensAsync(metadata.TokenEndpoint, new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = response.Code,
            ["redirect_uri"] = callback.AbsoluteUri,
            ["client_id"] = _settings.ClerkClientId!,
            ["code_verifier"] = verifier
        }, timeout.Token);
        var user = await GetUserAsync(tokens.AccessToken, timeout.Token);
        if (!string.IsNullOrEmpty(tokens.RefreshToken))
            await WriteRefreshTokenAsync(tokens.RefreshToken, timeout.Token);
        CurrentUser = user;
        return user;
    }

    public async Task SignOutAsync(CancellationToken cancellationToken)
    {
        try
        {
            var refreshToken = await ReadRefreshTokenAsync(cancellationToken);
            if (IsConfigured && !string.IsNullOrEmpty(refreshToken))
            {
                using var timeout = Timeout(cancellationToken, TimeSpan.FromSeconds(10));
                var metadata = await GetMetadataAsync(timeout.Token);
                if (metadata.RevocationEndpoint is not null)
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, metadata.RevocationEndpoint)
                    {
                        Content = new FormUrlEncodedContent(new Dictionary<string, string>
                        {
                            ["token"] = refreshToken,
                            ["token_type_hint"] = "refresh_token",
                            ["client_id"] = _settings.ClerkClientId!
                        })
                    };
                    await Http.SendAsync(request, timeout.Token);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            // Revocation is best-effort; clearing this device's credential is not.
        }
        finally
        {
            ClearRefreshToken();
            CurrentUser = null;
        }
    }

    private async Task<OAuthMetadata> GetMetadataAsync(CancellationToken cancellationToken)
    {
        var issuer = IssuerUri();
        var wellKnown = new Uri(issuer.AbsoluteUri.TrimEnd('/') + "/.well-known/oauth-authorization-server");
        using var response = await Http.GetAsync(wellKnown, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Clerk OAuth metadata request failed ({(int)response.StatusCode}).");

        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        return new OAuthMetadata(
            Endpoint(root, "authorization_endpoint"),
            Endpoint(root, "token_endpoint"),
            OptionalEndpoint(root, "revocation_endpoint"));
    }

    private async Task<TokenSet> RequestTokensAsync(Uri endpoint, Dictionary<string, string> fields, CancellationToken cancellationToken)
    {
        using var response = await Http.PostAsync(endpoint, new FormUrlEncodedContent(fields), cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Clerk token request failed ({(int)response.StatusCode}).");

        using var document = JsonDocument.Parse(body);
        var accessToken = String(document.RootElement, "access_token")
            ?? throw new InvalidOperationException("Clerk returned no access token.");
        return new TokenSet(accessToken, String(document.RootElement, "refresh_token"));
    }

    private async Task<ClerkUser> GetUserAsync(string accessToken, CancellationToken cancellationToken)
    {
        var issuer = IssuerUri();
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(issuer.AbsoluteUri.TrimEnd('/') + "/oauth/userinfo"));
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await Http.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Clerk userinfo request failed ({(int)response.StatusCode}).");

        using var document = JsonDocument.Parse(body);
        var user = document.RootElement;
        var id = String(user, "sub") ?? throw new InvalidOperationException("Clerk userinfo returned no subject.");
        var email = String(user, "email") ?? "";
        var name = String(user, "name") ?? String(user, "preferred_username") ?? (email.Length > 0 ? email : id);
        return new ClerkUser(id, name, email, String(user, "picture"));
    }

    private static async Task<CallbackResponse> ReadCallbackAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        using var client = await listener.AcceptTcpClientAsync(cancellationToken);
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, true);
        var requestLine = await reader.ReadLineAsync(cancellationToken) ?? throw new InvalidOperationException("Invalid OAuth callback.");
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(cancellationToken))) { }

        var parts = requestLine.Split(' ', 3);
        if (parts.Length < 2 || !string.Equals(parts[0], "GET", StringComparison.Ordinal) || !Uri.TryCreate("http://127.0.0.1" + parts[1], UriKind.Absolute, out var callback) || callback.AbsolutePath != CallbackPath)
            throw new InvalidOperationException("Invalid OAuth callback.");

        var query = ParseQuery(callback.Query);
        var page = Encoding.UTF8.GetBytes("<html><body>You may close this window.</body></html>");
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {page.Length}\r\nConnection: close\r\n\r\n"), cancellationToken);
        await stream.WriteAsync(page, cancellationToken);
        return new CallbackResponse(query.GetValueOrDefault("code"), query.GetValueOrDefault("state"), query.GetValueOrDefault("error"));
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            if (pair.Length != 2 || !values.TryAdd(Uri.UnescapeDataString(pair[0].Replace('+', ' ')), Uri.UnescapeDataString(pair[1].Replace('+', ' '))))
                throw new InvalidOperationException("Invalid OAuth callback query.");
        }
        return values;
    }

    private static string AddQuery(Uri uri, Dictionary<string, string> values)
    {
        var query = string.Join("&", values.Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
        var separator = string.IsNullOrEmpty(uri.Query) ? "?" : "&";
        return uri.AbsoluteUri + separator + query;
    }

    private Uri IssuerUri()
    {
        if (!Uri.TryCreate(_settings.ClerkIssuer, UriKind.Absolute, out var issuer) || issuer.Scheme != Uri.UriSchemeHttps || string.IsNullOrEmpty(issuer.Host) || !string.IsNullOrEmpty(issuer.Query) || !string.IsNullOrEmpty(issuer.Fragment))
            throw new InvalidOperationException("CD_CLERK_ISSUER must be an HTTPS issuer URL without a query or fragment.");
        return issuer;
    }

    private static Uri Endpoint(JsonElement root, string name) => OptionalEndpoint(root, name)
        ?? throw new InvalidOperationException($"Clerk OAuth metadata is missing {name}.");

    private static Uri? OptionalEndpoint(JsonElement root, string name)
    {
        var value = String(root, name);
        return Uri.TryCreate(value, UriKind.Absolute, out var endpoint) && endpoint.Scheme == Uri.UriSchemeHttps && !string.IsNullOrEmpty(endpoint.Host) && string.IsNullOrEmpty(endpoint.Fragment) ? endpoint : null;
    }

    private static string? String(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static CancellationTokenSource Timeout(CancellationToken cancellationToken, TimeSpan duration)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        source.CancelAfter(duration);
        return source;
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return [];
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '='));
    }

    private static string CredentialPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CD", "clerk-refresh-token.bin");

    private static async Task<string?> ReadRefreshTokenAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(CredentialPath))
            return null;
        var protectedBytes = await File.ReadAllBytesAsync(CredentialPath, cancellationToken);
        var bytes = Unprotect(protectedBytes);
        try { return Encoding.UTF8.GetString(bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static async Task WriteRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(refreshToken);
        try
        {
            var protectedBytes = Protect(bytes);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(CredentialPath)!);
                await File.WriteAllBytesAsync(CredentialPath, protectedBytes, cancellationToken);
            }
            finally { CryptographicOperations.ZeroMemory(protectedBytes); }
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static void ClearRefreshToken()
    {
        try { File.Delete(CredentialPath); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static byte[] Protect(byte[] input) => Crypt(input, CryptProtectData);
    private static byte[] Unprotect(byte[] input) => Crypt(input, CryptUnprotectData);

    private static byte[] Crypt(byte[] input, CryptData operation)
    {
        var inputHandle = GCHandle.Alloc(input, GCHandleType.Pinned);
        var entropyHandle = GCHandle.Alloc(CredentialEntropy, GCHandleType.Pinned);
        try
        {
            var inputBuffer = new DataBlob { cbData = (uint)input.Length, pbData = inputHandle.AddrOfPinnedObject() };
            var entropyBuffer = new DataBlob { cbData = (uint)CredentialEntropy.Length, pbData = entropyHandle.AddrOfPinnedObject() };
            const uint cryptProtectUiForbidden = 0x1;
            if (!operation(ref inputBuffer, null, ref entropyBuffer, IntPtr.Zero, IntPtr.Zero, cryptProtectUiForbidden, out var output))
                throw new CryptographicException(Marshal.GetLastWin32Error());
            try
            {
                if (output.cbData > int.MaxValue)
                    throw new CryptographicException("DPAPI returned an invalid credential length.");
                var result = new byte[(int)output.cbData];
                Marshal.Copy(output.pbData, result, 0, result.Length);
                return result;
            }
            finally { LocalFree(output.pbData); }
        }
        finally
        {
            entropyHandle.Free();
            inputHandle.Free();
        }
    }

    private delegate bool CryptData(ref DataBlob input, string? description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(ref DataBlob input, string? description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DataBlob input, string? description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public uint cbData;
        public IntPtr pbData;
    }

    private sealed record OAuthMetadata(Uri AuthorizationEndpoint, Uri TokenEndpoint, Uri? RevocationEndpoint);
    private sealed record TokenSet(string AccessToken, string? RefreshToken);
    private sealed record CallbackResponse(string? Code, string? State, string? Error);
}
