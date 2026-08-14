package io.github.gaalbu.aiusagewidget;

final class ProviderException extends Exception {
    private final boolean configured;

    ProviderException(String message, boolean configured) {
        super(message);
        this.configured = configured;
    }

    ProviderException(String message, boolean configured, Throwable cause) {
        super(message, cause);
        this.configured = configured;
    }

    boolean configured() {
        return configured;
    }
}
